import type { ChildProcess } from "node:child_process";
import type pino from "pino";
import type { SimReadiness } from "@jagentdesk/protocol/simulator/rpc-schemas";
import { DeviceError } from "./errors.js";
import { GoIosCommandError, type GoIos } from "./go-ios.js";
import type { PhysicalDeviceStore, WdaInstall } from "./store.js";
import { startLoopbackForward, type LoopbackForward } from "./usbmux.js";
import { WDA_DEVICE_PORT, WDA_MJPEG_DEVICE_PORT, WdaClient } from "./wda.js";

// iPhone / iPad over go-ios + WebDriverAgent (spec 27.1, 27.4).

export type IosFailure = "untrusted" | "locked" | "expired" | "developer_mode" | "other";

// Classifies go-ios / testmanagerd error text. Lockdown answers PairingDialogResponsePending while
// "Trust This Computer" is up, InvalidHostID/no pair record when it was never accepted; a locked
// device refuses developer services; an expired free-account profile fails the runner's signature.
export function classifyIosFailure(output: string): IosFailure {
  if (
    /PairingDialogResponsePending|InvalidHostID|UserDeniedPairing|PairRecord|not paired|pair record/i.test(
      output,
    )
  ) {
    return "untrusted";
  }
  if (
    /expired|Invalid code signature|no longer valid|untrusted developer|0xe8008021|0xe800801c/i.test(
      output,
    )
  ) {
    return "expired";
  }
  if (/Developer Mode|DeveloperMode/i.test(output)) return "developer_mode";
  if (/PasswordProtected|device is locked|DeviceLocked|is locked|passcode/i.test(output)) {
    return "locked";
  }
  return "other";
}

export interface IosReadinessInput {
  majorVersion: number;
  pairing: "paired" | "untrusted" | "locked";
  developerMode: boolean | null;
  wda: WdaInstall | null;
  wdaInstalled: boolean | null;
  lastWdaFailure: IosFailure | null;
  wdaLocked: boolean | null;
  now_ms: number;
}

// Spec 27.4: Trust → unlock → Developer Mode (iOS 16+) → WebDriverAgent installed and in date.
export function iosReadiness(input: IosReadinessInput): SimReadiness {
  if (input.pairing === "untrusted") return "needs_trust";
  if (input.pairing === "locked" || input.wdaLocked === true) return "needs_unlock";
  if (input.lastWdaFailure === "locked") return "needs_unlock";
  if (input.majorVersion >= 16 && input.developerMode === false) return "needs_developer_mode";
  if (input.lastWdaFailure === "developer_mode") return "needs_developer_mode";
  if (!input.wda || input.wdaInstalled === false) return "needs_wda";
  if (input.wda.expiresAt_ms <= input.now_ms || input.lastWdaFailure === "expired") {
    return "wda_expired";
  }
  return "ready";
}

export function iosMajorVersion(productVersion: string): number {
  const major = Number.parseInt(productVersion.split(".")[0] ?? "", 10);
  return Number.isFinite(major) ? major : 0;
}

// One `ios tunnel start --userspace` for every iOS 17+ device (go-ios agent mode; its info API
// listens on 127.0.0.1). Started on first use, kept for the daemon's lifetime.
export class IosTunnelAgent {
  private child: ChildProcess | null = null;

  constructor(
    private readonly goIos: GoIos,
    private readonly logger: pino.Logger,
  ) {}

  async ensure(): Promise<void> {
    if (this.child && this.child.exitCode === null) return;
    const child = this.goIos.tunnel();
    child.stderr?.on("data", (chunk: Buffer) => {
      this.logger.debug({ out: chunk.toString("utf8").trim() }, "go-ios tunnel");
    });
    child.on("exit", (code) => {
      this.logger.info({ code }, "go-ios tunnel exited");
      if (this.child === child) this.child = null;
    });
    this.child = child;
    // The agent publishes device tunnels a moment after start.
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
  }
}

export interface IosProbe {
  readiness: SimReadiness;
  deviceName: string;
}

interface RunningWda {
  process: ChildProcess;
  http: LoopbackForward;
  mjpeg: LoopbackForward;
  client: WdaClient;
}

const WDA_START_TIMEOUT_MS = 45_000;
const OUTPUT_TAIL_CHARS = 4_000;

export class IosDevice {
  private running: RunningWda | null = null;
  private starting: Promise<RunningWda> | null = null;
  lastWdaFailure: IosFailure | null = null;

  constructor(
    readonly udid: string,
    readonly majorVersion: number,
    private readonly deps: {
      goIos: GoIos;
      tunnel: IosTunnelAgent;
      store: PhysicalDeviceStore;
      logger: pino.Logger;
    },
  ) {}

  // Lockdown pairing/lock state + Developer Mode, without starting anything on the device.
  async probe(now_ms: number): Promise<IosProbe> {
    const { goIos, store } = this.deps;
    let pairing: IosReadinessInput["pairing"] = "paired";
    let deviceName = "";
    try {
      const values = await goIos.info(this.udid);
      deviceName = typeof values.DeviceName === "string" ? values.DeviceName : "";
    } catch (error) {
      const failure =
        error instanceof GoIosCommandError ? classifyIosFailure(error.output) : "other";
      pairing = failure === "locked" ? "locked" : "untrusted";
    }
    let developerMode: boolean | null = null;
    if (pairing === "paired" && this.majorVersion >= 16) {
      developerMode = await goIos.developerMode(this.udid).catch(() => null);
    }
    const wda = store.wda(this.udid);
    let wdaInstalled: boolean | null = null;
    if (pairing === "paired" && wda) {
      wdaInstalled = await goIos
        .userApps(this.udid)
        .then((apps) => apps.includes(wda.bundleId))
        .catch(() => null);
    }
    const wdaLocked = this.running ? await this.running.client.locked().catch(() => null) : null;
    const readiness = iosReadiness({
      majorVersion: this.majorVersion,
      pairing,
      developerMode,
      wda,
      wdaInstalled,
      lastWdaFailure: this.lastWdaFailure,
      wdaLocked,
      now_ms,
    });
    return { readiness, deviceName };
  }

  get mjpegPort(): number | null {
    return this.running?.mjpeg.port ?? null;
  }

  async wda(): Promise<WdaClient> {
    if (this.running && this.running.process.exitCode === null) return this.running.client;
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    return (await this.starting).client;
  }

  private async start(): Promise<RunningWda> {
    const { goIos, tunnel, store, logger } = this.deps;
    const install = store.wda(this.udid);
    if (!install) {
      throw new DeviceError(
        "device_not_ready",
        "WebDriverAgent is not installed on this device. Use Prepare device first.",
      );
    }
    if (this.majorVersion >= 17) await tunnel.ensure();
    const child = goIos.runWda(this.udid, install.bundleId);
    let output = "";
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL_CHARS);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const http = await startLoopbackForward({
      udid: this.udid,
      devicePort: WDA_DEVICE_PORT,
      logger,
    });
    const mjpeg = await startLoopbackForward({
      udid: this.udid,
      devicePort: WDA_MJPEG_DEVICE_PORT,
      logger,
    });
    const running: RunningWda = { process: child, http, mjpeg, client: new WdaClient(http.port) };
    child.on("exit", () => {
      this.lastWdaFailure = classifyIosFailure(output);
      logger.info({ udid: this.udid, failure: this.lastWdaFailure }, "WebDriverAgent exited");
      http.close();
      mjpeg.close();
      if (this.running === running) this.running = null;
    });
    const deadline = Date.now() + WDA_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      if (await running.client.status()) {
        this.lastWdaFailure = null;
        this.running = running;
        return running;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    child.kill();
    http.close();
    mjpeg.close();
    const failure = classifyIosFailure(output);
    this.lastWdaFailure = failure;
    throw new DeviceError(
      "device_not_ready",
      failure === "locked"
        ? "Unlock the device to start WebDriverAgent."
        : `WebDriverAgent did not start: ${output.trim().split("\n").pop() ?? "no output"}`,
    );
  }

  stop(): void {
    const running = this.running;
    this.running = null;
    if (!running) return;
    running.process.kill();
    running.http.close();
    running.mjpeg.close();
  }
}
