import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type pino from "pino";
import type {
  SideloadInstallMode,
  SideloadInstallProgress,
  SideloadInstallStep,
  SideloadOptions,
} from "@jagentdesk/protocol/sideload/rpc-schemas";
import type { SideloadAccounts, TeamSession } from "./accounts.js";
import { appIdName, type TeamAppId, type TeamCert, type TeamDevice } from "./apple/team-api.js";
import { editBundle, planBundle } from "./bundle.js";
import {
  certificateDerToPem,
  certificateMatchesKey,
  createSigningKey,
  parseProfile,
} from "./certs.js";
import { SideloadError, toSideloadError } from "./errors.js";
import type { GoIos } from "./ios-devices.js";
import { inspectIpa, type IpaInspection } from "./ipa.js";
import { checkFreeLimits } from "./limits.js";
import type { Signer } from "./signer.js";
import type { AppRecord, SideloadStorage, SigningIdentity } from "./storage.js";
import { extractZip } from "./zip.js";

/**
 * One sideload job (26.5): inspect → limits → team → device → certificate → App IDs →
 * profiles → sign → install, each step pushed as `sideload.install.progress`. Refresh (26.6)
 * is the same job with the stored IPA and options; the bundle id, hence the App ID, stays.
 */

const MACHINE_NAME = "JAgentDesk";

export interface JobRequest {
  ipaPath: string;
  mode: SideloadInstallMode;
  accountId: string | null;
  deviceUdid: string | null;
  options: SideloadOptions;
  autoRefresh: boolean | null;
  /** False for the background refresh: never wait on a 2FA prompt nobody sees. */
  interactive: boolean;
}

export interface JobOutcome {
  app: AppRecord | null;
  outputPath: string | null;
}

export interface PipelineDependencies {
  storage: SideloadStorage;
  accounts: SideloadAccounts;
  goIos: GoIos;
  signer: () => Signer | null;
  logger: pino.Logger;
  now: () => number;
  emit: (progress: SideloadInstallProgress) => void;
}

interface Job {
  id: string;
  controller: AbortController;
  done: Promise<JobOutcome>;
}

class Cancelled extends Error {}

export class SideloadPipeline {
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly deps: PipelineDependencies) {}

  start(request: JobRequest): string {
    const id = `slj_${randomBytes(5).toString("hex")}`;
    const controller = new AbortController();
    const done = this.run(id, request, controller.signal).finally(() => {
      this.jobs.delete(id);
    });
    // Callers that only start a job (the RPC) see failures through progress pushes.
    done.catch(() => undefined);
    this.jobs.set(id, { id, controller, done });
    return id;
  }

  wait(jobId: string): Promise<JobOutcome> {
    const job = this.jobs.get(jobId);
    if (!job) throw new SideloadError("not_found", "That job is not running.");
    return job.done;
  }

  cancel(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) throw new SideloadError("not_found", "That job is not running.");
    job.controller.abort();
  }

  private progress(
    jobId: string,
    step: SideloadInstallStep,
    message: string,
    extra: Partial<SideloadInstallProgress> = {},
  ): void {
    this.deps.emit({
      type: "sideload.install.progress",
      jobId,
      step,
      state: "running",
      message,
      percent: null,
      app: null,
      outputPath: null,
      code: null,
      ...extra,
    });
  }

  private async run(jobId: string, request: JobRequest, signal: AbortSignal): Promise<JobOutcome> {
    let step: SideloadInstallStep = "inspect";
    const work = path.join(this.deps.storage.workDir, jobId);
    const check = () => {
      if (signal.aborted) throw new Cancelled();
    };
    const enter = (next: SideloadInstallStep, message: string) => {
      check();
      step = next;
      this.deps.logger.info({ jobId, step: next }, "sideload job step");
      this.progress(jobId, next, message);
    };
    try {
      enter("inspect", "Checking the IPA");
      const inspection = await inspectIpa(request.ipaPath);
      if (inspection.encrypted && request.mode !== "install_as_is") {
        throw new SideloadError(
          "encrypted_ipa",
          "This IPA is still FairPlay-encrypted and will not run after re-signing. Use a decrypted IPA.",
        );
      }
      let outcome: JobOutcome;
      if (request.mode === "install_as_is") {
        outcome = await this.installAsIs(jobId, request, enter, signal);
      } else {
        outcome = await this.signJob({ jobId, request, inspection, work, enter, signal });
      }
      const message = outcome.outputPath ? "Signed IPA exported" : `${inspection.name} installed`;
      this.deps.emit({
        type: "sideload.install.progress",
        jobId,
        step,
        state: "done",
        message,
        percent: 100,
        app: outcome.app ? stripRecord(outcome.app) : null,
        outputPath: outcome.outputPath,
        code: null,
      });
      return outcome;
    } catch (error) {
      const cancelled = error instanceof Cancelled || signal.aborted;
      const failure = cancelled
        ? new SideloadError("cancelled", "Cancelled.")
        : toSideloadError(error);
      this.deps.logger.warn({ jobId, step, code: failure.code }, "sideload job failed");
      this.deps.emit({
        type: "sideload.install.progress",
        jobId,
        step,
        state: cancelled ? "cancelled" : "failed",
        message: failure.message,
        percent: null,
        app: null,
        outputPath: null,
        code: failure.code,
      });
      throw failure;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  private async installAsIs(
    jobId: string,
    request: JobRequest,
    enter: (step: SideloadInstallStep, message: string) => void,
    signal: AbortSignal,
  ): Promise<JobOutcome> {
    if (!request.deviceUdid) throw new SideloadError("invalid_input", "Choose a device.");
    enter("install", "Installing on the device");
    await this.deps.goIos.install({
      udid: request.deviceUdid,
      path: request.ipaPath,
      signal,
      onPercent: (percent, status) =>
        this.progress(jobId, "install", status || "Installing", { percent }),
    });
    return { app: null, outputPath: null };
  }

  private async signJob(input: {
    jobId: string;
    request: JobRequest;
    inspection: IpaInspection;
    work: string;
    enter: (step: SideloadInstallStep, message: string) => void;
    signal: AbortSignal;
  }): Promise<JobOutcome> {
    const { jobId, request, inspection, work, enter, signal } = input;
    const exporting = request.mode === "export";
    if (!request.accountId) throw new SideloadError("invalid_input", "Choose an Apple account.");
    if (!exporting && !request.deviceUdid)
      throw new SideloadError("invalid_input", "Choose a device.");
    const signer = this.deps.signer();
    if (!signer) {
      throw new SideloadError(
        "no_signer",
        "zsign is not installed. Install it from Settings → Host tools.",
      );
    }
    const account = this.deps.accounts.require(request.accountId);
    const plan = planBundle(inspection, request.options);
    const bundleIds = [
      plan.mainBundleId,
      ...plan.extensions.map((extension) => extension.bundleId),
    ];

    // 26.5: free-account limits from local records, before any request to Apple.
    const limits = checkFreeLimits({
      account,
      accounts: this.deps.storage.listAccounts(),
      deviceUdid: exporting ? "" : request.deviceUdid!,
      mainBundleId: plan.mainBundleId,
      bundleIds,
      apps: exporting ? [] : this.deps.storage.listApps(),
      usage: this.deps.storage.listAppIdUsage(),
      now: this.deps.now(),
    });
    if (!limits.ok) throw new SideloadError(limits.code, limits.message);

    enter("login", `Signing in to ${account.appleId}`);
    const session = await this.deps.accounts.team(account.id, request.interactive);

    let devices: TeamDevice[] = [];
    if (!exporting) {
      enter("register_device", "Registering the device with the team");
      devices = await this.registerDevice(session, request.deviceUdid!);
    } else {
      devices = await session.api.listDevices(session.teamId);
    }

    enter("certificate", "Preparing the development certificate");
    const identity = await this.signingIdentity(session);

    enter("app_id", `Preparing ${bundleIds.length} App ID(s)`);
    const appIds = await this.ensureAppIds(session, inspection, bundleIds);

    enter("profile", "Downloading provisioning profiles");
    const cert: TeamCert = {
      id: identity.certificateId,
      serialNumber: identity.serialNumber,
      name: MACHINE_NAME,
      machineName: MACHINE_NAME,
      machineId: identity.machineId,
      expiresAt_ms: identity.expiresAt_ms,
      der: Buffer.from(identity.certificateDerBase64, "base64"),
    };
    const profiles: Buffer[] = [];
    let expiresAt_ms = Number.POSITIVE_INFINITY;
    for (const appId of appIds) {
      const profile = await session.api.profile(session.teamId, { appId, cert, devices });
      const parsed = parseProfile(profile.data);
      if (!exporting && !parsed.provisionedDevices.includes(request.deviceUdid!)) {
        throw new SideloadError(
          "profile_mismatch",
          "The profile does not include this device yet; try again.",
        );
      }
      expiresAt_ms = Math.min(expiresAt_ms, parsed.expiresAt_ms);
      profiles.push(profile.data);
    }

    enter("sign", `Signing with ${signer.name}`);
    const payloadRoot = path.join(work, "bundle");
    await extractZip(request.ipaPath, payloadRoot, (entry) => entry.name.startsWith("Payload/"));
    const appDir = path.join(payloadRoot, inspection.appDir);
    const notes = await editBundle({ appDir, inspection, options: request.options, plan });
    for (const note of notes) this.progress(jobId, "sign", note);
    const signed = path.join(work, "signed.ipa");
    await signer.sign({
      appDir,
      outputIpa: signed,
      certificatePem: certificateDerToPem(cert.der!),
      privateKeyPem: identity.privateKeyPem,
      chainPem: [],
      profiles,
    });

    if (exporting) {
      enter("export", "Saving the signed IPA");
      const exportsDir = path.join(this.deps.storage.dir, "exports");
      await mkdir(exportsDir, { recursive: true, mode: 0o700 });
      const safeName = inspection.name.replace(/[^\w.-]+/g, "-") || "app";
      const outputPath = path.join(
        exportsDir,
        `${safeName}-${plan.mainBundleId}-${this.deps.now()}.ipa`,
      );
      await rename(signed, outputPath);
      return { app: null, outputPath };
    }

    enter("install", "Installing on the device");
    await this.deps.goIos.install({
      udid: request.deviceUdid!,
      path: signed,
      signal,
      onPercent: (percent, status) =>
        this.progress(jobId, "install", status || "Installing", { percent }),
    });

    const app = this.recordApp({
      request,
      inspection,
      mainBundleId: plan.mainBundleId,
      extensionBundleIds: plan.extensions.map((extension) => extension.bundleId),
      expiresAt_ms,
      kind: account.kind,
    });
    return { app, outputPath: null };
  }

  private async registerDevice(session: TeamSession, udid: string): Promise<TeamDevice[]> {
    const devices = await session.api.listDevices(session.teamId);
    if (devices.some((device) => device.udid.toLowerCase() === udid.toLowerCase())) return devices;
    const known = await this.deps.goIos.list().catch(() => []);
    const name = known.find((device) => device.udid === udid)?.name || "iPhone";
    const added = await session.api.addDevice(session.teamId, { udid, name });
    return [...devices, added];
  }

  /** The daemon's own development certificate for this team (reused while it is listed). */
  private async signingIdentity(session: TeamSession): Promise<SigningIdentity> {
    const { account, api, teamId } = session;
    const stored = await this.deps.storage.getSigningIdentity(account.id);
    const listed = await api.listCerts(teamId);
    if (stored && stored.teamId === teamId) {
      const live = listed.find(
        (cert) =>
          cert.serialNumber.toLowerCase() === stored.serialNumber.toLowerCase() ||
          cert.id === stored.certificateId,
      );
      const notExpired = stored.expiresAt_ms === null || stored.expiresAt_ms > this.deps.now();
      if (live && notExpired) return stored;
    }
    const key = createSigningKey(MACHINE_NAME);
    const machineId = randomUUID().toUpperCase();
    let issued: TeamCert;
    try {
      issued = await api.submitCsr(teamId, {
        csrPem: key.csrPem,
        machineName: MACHINE_NAME,
        machineId,
      });
    } catch (error) {
      // Teams hold few development certificates: replace an older JAgentDesk one, never others.
      const ours = listed.filter((cert) => cert.machineName?.startsWith(MACHINE_NAME));
      if (ours.length === 0) throw error;
      for (const cert of ours) await api.revokeCert(teamId, cert);
      issued = await api.submitCsr(teamId, {
        csrPem: key.csrPem,
        machineName: MACHINE_NAME,
        machineId,
      });
    }
    if (!issued.der || !certificateMatchesKey(issued.der, key.privateKeyPem)) {
      throw new SideloadError(
        "apple_error",
        "Apple returned a certificate that does not match the key.",
      );
    }
    const identity: SigningIdentity = {
      teamId,
      certificateId: issued.id,
      serialNumber: issued.serialNumber,
      machineId,
      privateKeyPem: key.privateKeyPem,
      certificateDerBase64: issued.der.toString("base64"),
      expiresAt_ms: issued.expiresAt_ms,
    };
    await this.deps.storage.setSigningIdentity(account.id, identity);
    return identity;
  }

  /** Reuses the team's App ID for each bundle id; creates and records the missing ones. */
  private async ensureAppIds(
    session: TeamSession,
    inspection: IpaInspection,
    bundleIds: readonly string[],
  ): Promise<TeamAppId[]> {
    const { account, api, teamId } = session;
    const existing = await api.listAppIds(teamId);
    const ledger = new Set(
      this.deps.storage
        .listAppIdUsage()
        .filter((usage) => usage.accountId === account.id)
        .map((usage) => usage.bundleId),
    );
    const result: TeamAppId[] = [];
    for (const bundleId of bundleIds) {
      const found = existing.find((candidate) => candidate.bundleId === bundleId) ?? null;
      const appId =
        found ??
        (await api.addAppId(teamId, { bundleId, name: appIdName(inspection.name, bundleId) }));
      // New App IDs count against the weekly limit; one Apple already had but the ledger did
      // not is recorded now (it was made within the last 7 days, or Apple would have dropped it).
      if (!found || !ledger.has(bundleId)) {
        this.deps.storage.recordAppId({
          accountId: account.id,
          appIdentifierId: appId.id,
          bundleId,
          createdAt_ms: this.deps.now(),
        });
      }
      result.push(appId);
    }
    return result;
  }

  private recordApp(input: {
    request: JobRequest;
    inspection: IpaInspection;
    mainBundleId: string;
    extensionBundleIds: string[];
    expiresAt_ms: number;
    kind: "free" | "paid";
  }): AppRecord {
    const { request, inspection } = input;
    const now = this.deps.now();
    const previous = this.deps.storage
      .listApps()
      .find(
        (app) =>
          app.accountId === request.accountId &&
          app.deviceUdid === request.deviceUdid &&
          app.bundleId === input.mainBundleId,
      );
    const app: AppRecord = {
      id: previous?.id ?? `sla_${randomBytes(4).toString("hex")}`,
      accountId: request.accountId!,
      deviceUdid: request.deviceUdid!,
      bundleId: input.mainBundleId,
      originalBundleId: inspection.bundleId,
      name: request.options.appName?.trim() || inspection.name,
      version: inspection.version,
      ipaSha256: inspection.sha256,
      options: request.options,
      installedAt_ms: previous?.installedAt_ms ?? now,
      expiresAt_ms: input.expiresAt_ms,
      autoRefresh: request.autoRefresh ?? previous?.autoRefresh ?? input.kind === "free",
      lastRefreshAt_ms: previous ? now : null,
      lastError: null,
      extensionBundleIds: input.extensionBundleIds,
    };
    this.deps.storage.upsertApp(app);
    return app;
  }
}

export function stripRecord(app: AppRecord): Omit<AppRecord, "extensionBundleIds"> {
  const { extensionBundleIds: _extensions, ...wire } = app;
  return wire;
}
