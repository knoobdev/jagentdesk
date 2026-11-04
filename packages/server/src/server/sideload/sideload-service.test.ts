import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import type { SideloadPush } from "@jagentdesk/protocol/sideload/rpc-schemas";
import type { AnisetteSourceAdapter } from "./apple/anisette.js";
import type { AppleHttpRequest } from "./apple/http.js";
import type { RunProcess } from "./process.js";
import { SideloadService } from "./sideload-service.js";
import type { Signer, SignInput } from "./signer.js";
import { FAKE_TEAM, createFakeDeveloperServices } from "./test-support/fake-developer-services.js";
import {
  ADSID,
  ANISETTE,
  APPLE_ID,
  IDMS,
  PASSWORD,
  createFakeGsa,
} from "./test-support/fake-gsa.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROBE_IPA = path.join(here, "test-fixtures", "probe.ipa");
const UDID = "00008110-000A1B2C3D4E5F6A";
const DAY = 24 * 3600_000;

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

/** go-ios as the daemon sees it: one paired iPhone on USB. */
const fakeGoIos: RunProcess = async (_command, args, options) => {
  const [verb] = args;
  if (verb === "list") {
    const device = {
      Udid: UDID,
      ProductName: "iPhone OS",
      ProductType: "iPhone14,2",
      ProductVersion: "17.5",
      ConnectionType: "USB",
    };
    return { code: 0, stdout: `${JSON.stringify({ deviceList: [device] })}\n`, stderr: "" };
  }
  if (verb === "devicename")
    return { code: 0, stdout: '{"devicename":"Test iPhone"}\n', stderr: "" };
  if (verb === "install") {
    options.onStderrLine?.(
      '{"level":"INFO","msg":"installing","status":"CreatingStagingDirectory","percentComplete":5}',
    );
    options.onStderrLine?.(
      '{"level":"INFO","msg":"installing","status":"Complete","percentComplete":100}',
    );
    return { code: 0, stdout: "", stderr: "" };
  }
  return { code: 0, stdout: "", stderr: "" };
};

class RecordingSigner implements Signer {
  readonly name = "zsign" as const;
  readonly signed: SignInput[] = [];
  async sign(input: SignInput): Promise<void> {
    this.signed.push(input);
    await copyFile(PROBE_IPA, input.outputIpa);
  }
}

async function setup(options: { kind?: "free" | "paid"; profileDays?: number } = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "jad-sideload-svc-"));
  homes.push(home);
  const logLines: string[] = [];
  const logger = pino(
    { level: "debug" },
    new Writable({
      write(chunk, _encoding, done) {
        logLines.push(String(chunk));
        done();
      },
    }),
  );
  const gsa = createFakeGsa({ twoFactor: "none" });
  const ds = createFakeDeveloperServices({
    kind: options.kind ?? "free",
    profileDays: options.profileDays ?? 7,
  });
  const hosts: string[] = [];
  const appleHttp = async (request: AppleHttpRequest) => {
    hosts.push(new URL(request.url).host);
    return request.url.startsWith("https://gsa.apple.com") ? gsa.http(request) : ds.http(request);
  };
  const pushes: SideloadPush[] = [];
  const signer = new RecordingSigner();
  const native: AnisetteSourceAdapter = { fetch: async (identity) => ({ ...ANISETTE, identity }) };
  const service = new SideloadService({
    jagentdeskHome: home,
    logger,
    broadcast: (message) => pushes.push(message),
    platform: "darwin",
    run: fakeGoIos,
    appleHttp,
    anisetteServerHttp: appleHttp,
    nativeAnisette: () => native,
    goIosPath: () => "/fake/go-ios/ios",
    adbPath: () => null,
    signer: () => signer,
  });
  service.storage.initialize();
  return { home, service, ds, hosts, pushes, signer, logLines };
}

async function addAppleId(service: SideloadService, keepSignedIn: boolean) {
  return service.addAccount({
    auth: "apple_id",
    appleId: APPLE_ID,
    password: PASSWORD,
    keepSignedIn,
    anisetteSource: "native",
    anisetteUrl: null,
    acceptedTerms: true,
  });
}

async function readAll(dir: string): Promise<string> {
  const parts: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      parts.push(await readFile(path.join(entry.parentPath, entry.name), "utf8"));
    }
  }
  return parts.join("\n");
}

describe("SideloadService", () => {
  it("requires the terms dialog before the first Apple ID", async () => {
    const { service, hosts } = await setup();
    await expect(
      service.addAccount({
        auth: "apple_id",
        appleId: APPLE_ID,
        password: PASSWORD,
        keepSignedIn: false,
        anisetteSource: "native",
        anisetteUrl: null,
        acceptedTerms: false,
      }),
    ).rejects.toMatchObject({ code: "terms_required" });
    expect(hosts).toEqual([]);
  });

  it("signs in, installs, and keeps every secret out of JSON files and logs", async () => {
    const { home, service, ds, pushes, signer, logLines } = await setup();
    const account = await addAppleId(service, true);
    expect(account).toMatchObject({
      kind: "free",
      teamId: FAKE_TEAM,
      signedIn: true,
      appIdsUsed: 0,
      appIdsLimit: 10,
    });

    const result = await service.signAndInstall({
      accountId: account.id,
      deviceUdid: UDID,
      ipaPath: PROBE_IPA,
      options: { bundleId: "dev.jagentdesk.probe.two" },
    });
    expect(result.bundleId).toBe("dev.jagentdesk.probe.two");
    expect(result.expiresAt_ms).toBeGreaterThan(Date.now() + 6 * DAY);

    // Developer Services requests carry the Xcode token, the account and anisette.
    const call = ds.state.calls.find((entry) => entry.action === "ios/addAppId")!;
    expect(call.headers["X-Apple-GS-Token"]).toBe("xcode-token");
    expect(call.headers["X-Apple-I-Identity-Id"]).toBe(ADSID);
    expect(call.headers["X-Apple-I-MD"]).toBe("otp-value");
    expect(call.body).toMatchObject({
      clientId: "XABBG36SBA",
      protocolVersion: "QH65B2",
      teamId: FAKE_TEAM,
    });
    expect(ds.state.calls.map((entry) => entry.action)).toEqual([
      "listTeams",
      "ios/listDevices",
      "ios/addDevice",
      "ios/listAllDevelopmentCerts",
      "ios/submitDevelopmentCSR",
      "ios/listAllDevelopmentCerts",
      "ios/listAppIds",
      "ios/addAppId",
      "ios/addAppId",
      "ios/downloadTeamProvisioningProfile",
      "ios/downloadTeamProvisioningProfile",
    ]);
    expect(ds.state.appIds.map((appId) => appId.identifier)).toEqual([
      "dev.jagentdesk.probe.two",
      "dev.jagentdesk.probe.two.share",
    ]);
    expect(signer.signed[0]!.profiles).toHaveLength(2);
    const progress = pushes.filter((push) => push.type === "sideload.install.progress");
    expect(progress.at(-1)).toMatchObject({ state: "done", step: "install", percent: 100 });

    const persisted = await readAll(path.join(home, "sideload"));
    const logs = logLines.join("");
    for (const secret of [
      PASSWORD,
      "xcode-token",
      IDMS,
      "PRIVATE KEY",
      "otp-value",
      "machine-id",
    ]) {
      expect(persisted).not.toContain(secret);
      expect(logs).not.toContain(secret);
    }
    expect((await service.listAccounts())[0]).toMatchObject({ appIdsUsed: 2 });
  });

  it("refreshes with the same App IDs and keeps the app record", async () => {
    const { service, ds } = await setup();
    const account = await addAppleId(service, true);
    const first = await service.signAndInstall({
      accountId: account.id,
      deviceUdid: UDID,
      ipaPath: PROBE_IPA,
    });
    const addAppIdCalls = ds.state.calls.filter((entry) => entry.action === "ios/addAppId").length;
    await service.pipeline.wait(service.refreshApp(first.appId));
    expect(ds.state.calls.filter((entry) => entry.action === "ios/addAppId")).toHaveLength(
      addAppIdCalls,
    );
    expect(service.storage.listAppIdUsage()).toHaveLength(2);
    expect(service.listApps()).toHaveLength(1);
    expect(service.listApps()[0]).toMatchObject({ id: first.appId, lastError: null });
    expect(service.listApps()[0]!.lastRefreshAt_ms).not.toBeNull();
  });

  it("refuses a fourth free app on a device before calling Apple", async () => {
    const { service, hosts } = await setup();
    const account = await addAppleId(service, true);
    for (const index of [1, 2, 3]) {
      service.storage.upsertApp({
        id: `sla_00${index}`,
        accountId: account.id,
        deviceUdid: UDID,
        bundleId: `dev.example.app${index}`,
        originalBundleId: `dev.example.app${index}`,
        name: `App ${index}`,
        version: "1.0",
        ipaSha256: "0".repeat(64),
        options: {},
        installedAt_ms: Date.now(),
        expiresAt_ms: Date.now() + 6 * DAY,
        autoRefresh: true,
        lastRefreshAt_ms: null,
        lastError: null,
        extensionBundleIds: [],
      });
    }
    const before = hosts.length;
    await expect(
      service.signAndInstall({ accountId: account.id, deviceUdid: UDID, ipaPath: PROBE_IPA }),
    ).rejects.toMatchObject({ code: "free_app_limit" });
    expect(hosts.length).toBe(before);
  });

  it("refuses an install that would pass 10 App IDs in 7 days and says when", async () => {
    const { service, hosts } = await setup();
    const account = await addAppleId(service, true);
    const start = Date.now() - 5 * DAY;
    for (let index = 0; index < 9; index += 1) {
      service.storage.recordAppId({
        accountId: account.id,
        appIdentifierId: `APPID${index}`,
        bundleId: `dev.example.id${index}`,
        createdAt_ms: start + index * 1000,
      });
    }
    const before = hosts.length;
    const error = await service
      .signAndInstall({ accountId: account.id, deviceUdid: UDID, ipaPath: PROBE_IPA })
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: "app_id_limit" });
    expect((error as Error).message).toContain(new Date(start + 7 * DAY).toISOString());
    expect(hosts.length).toBe(before);
  });

  it("asks every client to sign in again when the session expired and no password is kept", async () => {
    const { service, pushes, hosts } = await setup();
    const account = await addAppleId(service, false);
    const app = await service.signAndInstall({
      accountId: account.id,
      deviceUdid: UDID,
      ipaPath: PROBE_IPA,
    });
    await service.storage.setXcodeAuth(account.id, {
      adsid: ADSID,
      token: "old",
      expiresAt_ms: Date.now() - 1000,
    });
    const current = service.storage.getApp(app.appId)!;
    service.storage.upsertApp({ ...current, expiresAt_ms: Date.now() + DAY });
    const before = hosts.length;
    await service.refreshJob.checkNow();
    expect(hosts.length).toBe(before);
    expect(pushes.filter((push) => push.type === "sideload.notice")).toEqual([
      expect.objectContaining({
        kind: "sign_in_again",
        accountId: account.id,
        title: "Sign in again",
      }),
    ]);
    expect((await service.listAccounts())[0]!.signedIn).toBe(false);
  });

  it("the hourly job re-signs an app with one day left", async () => {
    const { service, ds } = await setup();
    const account = await addAppleId(service, true);
    const app = await service.signAndInstall({
      accountId: account.id,
      deviceUdid: UDID,
      ipaPath: PROBE_IPA,
    });
    const current = service.storage.getApp(app.appId)!;
    service.storage.upsertApp({ ...current, expiresAt_ms: Date.now() + DAY });
    const appIds = ds.state.appIds.length;
    await service.refreshJob.checkNow();
    const refreshed = service.storage.getApp(app.appId)!;
    expect(refreshed.expiresAt_ms).toBeGreaterThan(Date.now() + 6 * DAY);
    expect(refreshed.lastRefreshAt_ms).not.toBeNull();
    expect(ds.state.appIds).toHaveLength(appIds);
  });

  it("stores passwords only encrypted, and only with keepSignedIn", async () => {
    const { home, service } = await setup();
    await addAppleId(service, false);
    const vault = await readFile(path.join(home, "sideload", "secrets.json"), "utf8");
    expect(vault).not.toContain(PASSWORD);
    const account = service.storage.listAccounts()[0]!;
    expect(await service.storage.getPassword(account.id)).toBeNull();
  });
});
