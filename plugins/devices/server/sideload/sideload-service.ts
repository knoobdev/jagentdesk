import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type pino from "pino";
import type {
  SideloadAccountSummary,
  SideloadAppId,
  SideloadCert,
  SideloadDevice,
  SideloadInstallMode,
  SideloadIpaInfo,
  SideloadNotice,
  SideloadOptions,
  SideloadPush,
} from "@jagentdesk/protocol/sideload/rpc-schemas";
import { SideloadAccounts, type AddAccountInput } from "./accounts.js";
import { Adb } from "./android.js";
import {
  NativeMacAnisette,
  UnavailableNativeAnisette,
  type AnisetteSourceAdapter,
} from "./apple/anisette.js";
import type { TwoFactorAnswer } from "./apple/gsa.js";
import { createAnisetteServerHttp, createAppleHttp, type AppleHttp } from "./apple/http.js";
import { SideloadError, toSideloadError } from "./errors.js";
import { browseHost, type HostBrowseKind, type HostBrowseResult } from "./host-browse.js";
import { GoIos } from "./ios-devices.js";
import { inspectIpa, storeIpa } from "./ipa.js";
import { SideloadPipeline, stripRecord, type JobRequest } from "./pipeline.js";
import { runProcess, type RunProcess } from "./process.js";
import { SideloadRefreshJob } from "./refresh-job.js";
import { CodesignSigner, ZsignSigner, type Signer } from "./signer.js";
import { SideloadStorage, type AppRecord } from "./storage.js";
import { resolveAdb, resolveHostTool } from "./tools.js";

const execFileAsync = promisify(execFile);

/** What a sideload account offers other daemon features (spec 27 signs WebDriverAgent). */
export interface SideloadSigner {
  listAccounts(): Promise<SideloadAccountSummary[]>;
  signAndInstall(input: {
    accountId: string;
    deviceUdid: string;
    ipaPath: string;
    options?: SideloadOptions;
    autoRefresh?: boolean;
  }): Promise<{ appId: string; bundleId: string; expiresAt_ms: number }>;
  /** Installed apps; physical devices read WebDriverAgent's expiry after an auto refresh. */
  listApps?(): Array<{ deviceUdid: string; bundleId: string; expiresAt_ms: number }>;
}

export interface SideloadServiceOptions {
  jagentdeskHome: string;
  logger: pino.Logger;
  /** Every connected client: prompts, progress, notices. */
  broadcast: (message: SideloadPush) => void;
  /** Mobile push for notices (26.6 "mọi client đã pair"). */
  pushNotification?: (notice: { title: string; body: string }) => void;
  platform?: NodeJS.Platform;
  run?: RunProcess;
  appleHttp?: AppleHttp;
  anisetteServerHttp?: AppleHttp;
  nativeAnisette?: () => AnisetteSourceAdapter;
  goIosPath?: () => string | null;
  adbPath?: () => string | null;
  signer?: () => Signer | null;
  /** Shifts the sideload clock (refresh job, limits) — acceptance runs of 26.12.4. */
  clockOffsetMs?: number;
  refreshIntervalMs?: number;
}

function defaultNativeAnisette(
  platform: NodeJS.Platform,
  run: RunProcess,
): () => AnisetteSourceAdapter {
  if (platform === "darwin") {
    const adapter = new NativeMacAnisette((command, args) =>
      run(command, args, { timeoutMs: 20_000 }),
    );
    return () => adapter;
  }
  const reason =
    platform === "win32"
      ? "Native anisette on Windows (iCloud's CoreADI) is not available in this build. Use a remote anisette server you run."
      : "Linux has no native anisette. Use a remote anisette server you run.";
  return () => new UnavailableNativeAnisette(reason);
}

export class SideloadService implements SideloadSigner {
  readonly storage: SideloadStorage;
  readonly accounts: SideloadAccounts;
  readonly pipeline: SideloadPipeline;
  readonly refreshJob: SideloadRefreshJob;
  readonly goIos: GoIos;
  readonly adb: Adb;
  private readonly logger: pino.Logger;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private readonly signerFactory: () => Signer | null;

  constructor(private readonly options: SideloadServiceOptions) {
    this.logger = options.logger.child({ module: "sideload" });
    this.platform = options.platform ?? process.platform;
    const offset = options.clockOffsetMs ?? 0;
    this.now = () => Date.now() + offset;
    const run = options.run ?? runProcess;
    const appleHttp = options.appleHttp ?? createAppleHttp(this.logger);
    this.storage = new SideloadStorage(options.jagentdeskHome);
    this.goIos = new GoIos(
      options.goIosPath ?? (() => resolveHostTool(options.jagentdeskHome, "ios")),
      run,
    );
    this.adb = new Adb(options.adbPath ?? (() => resolveAdb(options.jagentdeskHome)), run);
    this.signerFactory = options.signer ?? (() => this.defaultSigner());
    this.accounts = new SideloadAccounts({
      storage: this.storage,
      logger: this.logger,
      appleHttp,
      anisetteServerHttp: options.anisetteServerHttp ?? createAnisetteServerHttp(this.logger),
      nativeAnisette: options.nativeAnisette ?? defaultNativeAnisette(this.platform, run),
      platform: this.platform,
      now: this.now,
      emitPrompt: (prompt) => options.broadcast(prompt),
      emitPromptResolved: (promptId) =>
        options.broadcast({ type: "sideload.auth.resolved", promptId }),
    });
    this.pipeline = new SideloadPipeline({
      storage: this.storage,
      accounts: this.accounts,
      goIos: this.goIos,
      signer: this.signerFactory,
      logger: this.logger,
      now: this.now,
      emit: (progress) => options.broadcast(progress),
    });
    this.refreshJob = new SideloadRefreshJob({
      storage: this.storage,
      accounts: this.accounts,
      pipeline: this.pipeline,
      logger: this.logger,
      now: this.now,
      intervalMs: options.refreshIntervalMs,
      visibleDevices: async () =>
        new Set(
          this.goIos.available() ? (await this.goIos.list()).map((device) => device.udid) : [],
        ),
      notify: (notice) => this.notify(notice),
    });
  }

  initialize(): void {
    this.storage.initialize();
    this.refreshJob.start();
  }

  dispose(): void {
    this.refreshJob.stop();
  }

  private defaultSigner(): Signer | null {
    const zsign = resolveHostTool(this.options.jagentdeskHome, "zsign");
    if (zsign) return new ZsignSigner(zsign);
    return this.platform === "darwin" ? new CodesignSigner() : null;
  }

  /** zsign when it runs here; codesign on macOS otherwise. */
  async signerName(): Promise<string | null> {
    const zsign = resolveHostTool(this.options.jagentdeskHome, "zsign");
    if (zsign) {
      const ok = await execFileAsync(zsign, ["-v"]).then(
        () => true,
        () => false,
      );
      if (ok) return "zsign";
    }
    return this.platform === "darwin" ? "codesign" : null;
  }

  private notify(notice: Omit<SideloadNotice, "type" | "at_ms">): void {
    this.options.broadcast({ type: "sideload.notice", ...notice, at_ms: this.now() });
    this.options.pushNotification?.({ title: notice.title, body: notice.body });
  }

  // ── accounts ──

  listAccounts(): Promise<SideloadAccountSummary[]> {
    return this.accounts.summaries();
  }

  async addAccount(input: AddAccountInput): Promise<SideloadAccountSummary> {
    const account = await this.accounts.add(input);
    return this.summary(account.id);
  }

  async summary(accountId: string): Promise<SideloadAccountSummary> {
    const found = (await this.accounts.summaries()).find((account) => account.id === accountId);
    if (!found) throw new SideloadError("not_found", "That Apple account no longer exists.");
    return found;
  }

  respondToPrompt(promptId: string, answer: TwoFactorAnswer): void {
    this.accounts.respond(promptId, answer);
  }

  // ── devices ──

  async listDevices(): Promise<{
    devices: SideloadDevice[];
    iosUnavailableReason: string;
    androidUnavailableReason: string;
  }> {
    const devices: SideloadDevice[] = [];
    let iosUnavailableReason = "";
    let androidUnavailableReason = "";
    try {
      for (const device of await this.goIos.list()) {
        devices.push({
          platform: "ios",
          id: device.udid,
          name: device.name,
          model: device.model,
          osVersion: device.osVersion,
          connection: device.connection,
          ready: device.paired,
          notReadyReason: device.paired ? null : "Unlock the device and tap Trust This Computer.",
        });
      }
    } catch (error) {
      iosUnavailableReason = toSideloadError(error).message;
    }
    try {
      for (const device of await this.adb.list()) {
        const ready = device.state === "device";
        devices.push({
          platform: "android",
          id: device.serial,
          name: device.model || device.serial,
          model: device.model,
          osVersion: device.osVersion,
          connection: device.connection,
          ready,
          notReadyReason: ready ? null : androidNotReady(device.state),
        });
      }
    } catch (error) {
      androidUnavailableReason = toSideloadError(error).message;
    }
    return { devices, iosUnavailableReason, androidUnavailableReason };
  }

  // ── IPA ──

  /** Moves an upload (or copies a host path) into sideload/ipa/<sha256>.ipa and inspects it. */
  async uploadIpa(source: string): Promise<SideloadIpaInfo> {
    const resolved = path.resolve(source);
    await stat(resolved).catch(() => {
      throw new SideloadError("not_found", `${source} does not exist on the daemon host.`);
    });
    const uploads = path.join(this.options.jagentdeskHome, "uploads");
    const fromUpload = resolved.startsWith(`${uploads}${path.sep}`);
    const inspection = await inspectIpa(resolved).catch((error: unknown) => {
      throw toSideloadError(error);
    });
    const stored = await storeIpa({
      source: resolved,
      ipaDir: this.storage.ipaDir,
      move: fromUpload,
    });
    return this.ipaInfo(stored.path, inspection);
  }

  async inspect(file: string): Promise<SideloadIpaInfo> {
    const inspection = await inspectIpa(path.resolve(file)).catch((error: unknown) => {
      throw toSideloadError(error);
    });
    return this.ipaInfo(path.resolve(file), inspection);
  }

  private ipaInfo(
    file: string,
    inspection: Awaited<ReturnType<typeof inspectIpa>>,
  ): SideloadIpaInfo {
    return {
      path: file,
      sha256: inspection.sha256,
      sizeBytes: inspection.sizeBytes,
      name: inspection.name,
      bundleId: inspection.bundleId,
      version: inspection.version,
      minimumOs: inspection.minimumOs,
      encrypted: inspection.encrypted,
      architectures: inspection.architectures,
      extensions: inspection.extensions,
      hasWatchApp: inspection.hasWatchApp,
      signed: inspection.signed,
    };
  }

  /** The stored copy refresh re-signs; any other path is stored first. */
  private async storedIpaPath(file: string): Promise<string> {
    const resolved = path.resolve(file);
    if (path.dirname(resolved) === this.storage.ipaDir) return resolved;
    return (await this.uploadIpa(resolved)).path;
  }

  // ── jobs ──

  async startInstall(input: {
    path: string;
    deviceUdid: string;
    accountId: string | null;
    mode: SideloadInstallMode;
    options: SideloadOptions;
    autoRefresh: boolean | null;
  }): Promise<string> {
    const ipaPath = await this.storedIpaPath(input.path);
    return this.pipeline.start({
      ipaPath,
      mode: input.mode,
      accountId: input.accountId,
      deviceUdid: input.deviceUdid,
      options: input.options,
      autoRefresh: input.autoRefresh,
      interactive: true,
    });
  }

  async startExport(input: {
    path: string;
    accountId: string;
    options: SideloadOptions;
  }): Promise<string> {
    const ipaPath = await this.storedIpaPath(input.path);
    return this.pipeline.start({
      ipaPath,
      mode: "export",
      accountId: input.accountId,
      deviceUdid: null,
      options: input.options,
      autoRefresh: null,
      interactive: true,
    });
  }

  cancelJob(jobId: string): void {
    this.pipeline.cancel(jobId);
  }

  async signAndInstall(input: {
    accountId: string;
    deviceUdid: string;
    ipaPath: string;
    options?: SideloadOptions;
    autoRefresh?: boolean;
  }): Promise<{ appId: string; bundleId: string; expiresAt_ms: number }> {
    const jobId = await this.startInstall({
      path: input.ipaPath,
      deviceUdid: input.deviceUdid,
      accountId: input.accountId,
      mode: "sign_install",
      options: input.options ?? {},
      autoRefresh: input.autoRefresh ?? null,
    });
    const outcome = await this.pipeline.wait(jobId);
    if (!outcome.app)
      throw new SideloadError("internal_error", "The install produced no app record.");
    return {
      appId: outcome.app.id,
      bundleId: outcome.app.bundleId,
      expiresAt_ms: outcome.app.expiresAt_ms,
    };
  }

  // ── installed apps ──

  listApps(): ReturnType<typeof stripRecord>[] {
    return this.storage.listApps().map(stripRecord);
  }

  private requireApp(appId: string): AppRecord {
    const app = this.storage.getApp(appId);
    if (!app) throw new SideloadError("not_found", "That app is no longer in the list.");
    return app;
  }

  refreshApp(appId: string): string {
    const app = this.requireApp(appId);
    const request: JobRequest = {
      ipaPath: path.join(this.storage.ipaDir, `${app.ipaSha256}.ipa`),
      mode: "sign_install",
      accountId: app.accountId,
      deviceUdid: app.deviceUdid,
      options: app.options,
      autoRefresh: app.autoRefresh,
      interactive: true,
    };
    return this.pipeline.start(request);
  }

  refreshAll(deviceUdid: string): string[] {
    return this.storage
      .listApps()
      .filter((app) => app.deviceUdid === deviceUdid)
      .map((app) => this.refreshApp(app.id));
  }

  async uninstallApp(appId: string): Promise<void> {
    const app = this.requireApp(appId);
    await this.goIos.uninstall(app.deviceUdid, app.bundleId).catch((error: unknown) => {
      throw toSideloadError(error);
    });
    this.storage.removeApp(appId);
  }

  forgetApp(appId: string): void {
    this.requireApp(appId);
    this.storage.removeApp(appId);
  }

  // ── team certificates and App IDs ──

  async listCerts(accountId: string): Promise<SideloadCert[]> {
    const session = await this.accounts.team(accountId, true);
    const identity = await this.storage.getSigningIdentity(accountId);
    const certs = await session.api.listCerts(session.teamId);
    return certs.map((cert) => ({
      id: cert.id,
      serialNumber: cert.serialNumber,
      name: cert.name,
      machineName: cert.machineName,
      expiresAt_ms: cert.expiresAt_ms,
      ownedByDaemon: identity?.certificateId === cert.id,
    }));
  }

  async revokeCert(accountId: string, certId: string): Promise<void> {
    const session = await this.accounts.team(accountId, true);
    const cert = (await session.api.listCerts(session.teamId)).find(
      (candidate) => candidate.id === certId,
    );
    if (!cert) throw new SideloadError("not_found", "That certificate is not on the team.");
    await session.api.revokeCert(session.teamId, cert);
    const identity = await this.storage.getSigningIdentity(accountId);
    if (identity?.certificateId === certId) await this.storage.setSigningIdentity(accountId, null);
  }

  async listAppIds(accountId: string): Promise<SideloadAppId[]> {
    const session = await this.accounts.team(accountId, true);
    return session.api.listAppIds(session.teamId);
  }

  // ── Android ──

  async androidInstall(serial: string, paths: string[]): Promise<string> {
    return this.adb.install(serial, paths).catch((error: unknown) => {
      throw toSideloadError(error);
    });
  }

  // ── Browse host… (26.9, ADR-0032 §9) ──

  async browseHost(input: { path?: string; kind: HostBrowseKind }): Promise<HostBrowseResult> {
    return browseHost(input).catch((error: unknown) => {
      throw toSideloadError(error);
    });
  }
}

function androidNotReady(state: string): string {
  if (state === "unauthorized") return "Allow USB debugging on the phone (accept the RSA key).";
  if (state === "offline") return "The device is offline. Reconnect it.";
  return `adb reports ${state}.`;
}
