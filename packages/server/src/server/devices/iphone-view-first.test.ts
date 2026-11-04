import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SimSignerAccount } from "@jagentdesk/protocol/simulator/rpc-schemas";
import { findExecutable } from "../../executable-resolution/executable-resolution.js";
import { DeviceError } from "./errors.js";
import { PhysicalDeviceHub, type ScreenFrameEvent } from "./hub.js";
import { WDA_VERSION } from "./wda.js";
import type { DeviceSigner } from "./wda-prepare.js";
import { FAKE_IOS_UDID, writeFakeGoIos, type FakeGoIos } from "./test-utils/fake-go-ios.js";

// Spec 27.4 / 27.5 / ADR-0033 decision 8 through the real hub against a test go-ios: the screen
// shows after Enable control with no WDA and no Apple account; touch asks for setup.

const UDID = `ios:${FAKE_IOS_UDID}`;
const ACCOUNT: SimSignerAccount = { id: "apl_a1b2c3", label: "<apple-id> (Free · Personal Team)" };
const encoderAvailable = process.platform === "darwin" || (await findExecutable("ffmpeg")) !== null;

let home: string;
let fake: FakeGoIos;
let previousBin: string | undefined;
let hub: PhysicalDeviceHub | null = null;

function signer(accounts: SimSignerAccount[]): DeviceSigner & {
  signAndInstall: ReturnType<typeof vi.fn>;
} {
  return {
    listAccounts: async () => accounts,
    signAndInstall: vi.fn(async () => ({
      appId: "sla_a1b2c3",
      bundleId: "com.facebook.WebDriverAgentRunner.xctrunner",
      expiresAt_ms: Date.now() + 7 * 86_400_000,
    })),
  };
}

function createHub(deviceSigner: DeviceSigner | null): PhysicalDeviceHub {
  hub = new PhysicalDeviceHub({
    jagentdeskHome: home,
    logger: pino({ level: "silent" }),
    signer: deviceSigner,
  });
  return hub;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return error instanceof DeviceError ? error.code : String(error);
  }
}

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "jad-view-first-"));
  fake = writeFakeGoIos(path.join(home, "fake-go-ios"));
  previousBin = process.env.JAGENTDESK_GO_IOS_BIN;
  process.env.JAGENTDESK_GO_IOS_BIN = fake.binary;
});

afterEach(async () => {
  hub?.dispose();
  hub = null;
  if (previousBin === undefined) delete process.env.JAGENTDESK_GO_IOS_BIN;
  else process.env.JAGENTDESK_GO_IOS_BIN = previousBin;
  await rm(home, { recursive: true, force: true });
});

describe("iPhone: view first, touch later", () => {
  it("lists an iPhone without WDA as connected with its screen available", async () => {
    const devices = await createHub(signer([])).list();
    const iphone = devices.find((device) => device.udid === UDID);
    expect(iphone).toMatchObject({
      name: "<device name>",
      kind: "physical",
      controlEnabled: false,
      readiness: "needs_wda",
      screenAvailable: true,
      state: "Connected",
    });
  });

  it.skipIf(!encoderAvailable)(
    "streams screenshots after Enable control, mounting the Developer Disk Image itself",
    async () => {
      const devices = createHub(signer([]));
      await devices.list();
      const listener = { onFrame: vi.fn(), onEnd: vi.fn() };
      expect(await codeOf(devices.subscribeScreen(UDID, listener))).toBe("control_disabled");
      await devices.enable(UDID);
      const frames: ScreenFrameEvent[] = [];
      const subscription = await devices.subscribeScreen(UDID, {
        onFrame: (frame) => frames.push(frame),
        onEnd: () => {},
      });
      expect(subscription.source).toBe("screencap");
      await vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(2), {
        timeout: 15_000,
        interval: 100,
      });
      expect(frames[0].jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      expect(frames[0].height).toBeGreaterThan(frames[0].width);
      const calls = await readFile(fake.callsLog, "utf8");
      expect(calls).toMatch(/^image auto --basedir=.*devices\/ddi --udid=/m);
      expect(calls).not.toMatch(/^runwda/m);
      subscription.unsubscribe();

      const shot = await devices.screenshot(UDID, { format: "jpeg" });
      expect(shot.mimeType).toBe("image/jpeg");
      expect(shot.base64.length).toBeGreaterThan(0);
    },
    30_000,
  );

  it("answers a touch from the app with wda_required instead of a separate Prepare step", async () => {
    const devices = createHub(signer([ACCOUNT]));
    await devices.list();
    await devices.enable(UDID);
    expect(await codeOf(devices.tap(UDID, 0.5, 0.5, "ratio"))).toBe("wda_required");
    expect(await codeOf(devices.inputText(UDID, "hello"))).toBe("wda_required");
    expect(await codeOf(devices.button(UDID, "home"))).toBe("wda_required");
  });

  it("Enable touch: no account → no_apple_account, several → account_required", async () => {
    const none = createHub(signer([]));
    await none.list();
    await none.enable(UDID);
    expect(await codeOf(none.prepare(UDID, undefined, () => {}))).toBe("no_apple_account");
    none.dispose();

    const several = createHub(
      signer([ACCOUNT, { id: "apl_d4e5f6", label: "<apple-id-b> (Paid)" }]),
    );
    await several.list();
    expect(await codeOf(several.prepare(UDID, undefined, () => {}))).toBe("account_required");
  });

  it("an agent touch with no saved account answers apple_account_required", async () => {
    const devices = createHub(signer([]));
    await devices.list();
    await devices.enable(UDID);
    const error = await devices.tap(UDID, 10, 10, "device", "agent").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeviceError);
    expect((error as DeviceError).code).toBe("apple_account_required");
    expect((error as DeviceError).message).toMatch(/add an Apple ID/);
  });

  it("an agent touch with one saved account signs WDA with it before touching", async () => {
    // The unsigned runner already downloaded (no network in tests).
    const wdaDir = path.join(home, "devices", "wda", WDA_VERSION);
    await mkdir(wdaDir, { recursive: true });
    await writeFile(path.join(wdaDir, "WebDriverAgentRunner.ipa"), "ipa");
    const deviceSigner = signer([ACCOUNT]);
    const devices = createHub(deviceSigner);
    await devices.list();
    await devices.enable(UDID);
    // The test go-ios cannot run WDA, so the touch itself fails after signing.
    await devices.tap(UDID, 10, 10, "device", "agent").catch(() => {});
    expect(deviceSigner.signAndInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: ACCOUNT.id,
        deviceUdid: FAKE_IOS_UDID,
        autoRefresh: true,
      }),
    );
    const store = JSON.parse(
      await readFile(path.join(home, "devices", "physical.json"), "utf8"),
    ) as { devices: Record<string, { wda: { accountId: string } | null }> };
    expect(store.devices[UDID]?.wda?.accountId).toBe(ACCOUNT.id);
    expect(existsSync(fake.callsLog)).toBe(true);
  }, 60_000);
});
