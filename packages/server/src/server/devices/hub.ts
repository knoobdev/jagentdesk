import type { ChildProcess } from "node:child_process";
import type pino from "pino";
import type {
  SimButton,
  SimCoords,
  SimDevice,
  SimReadiness,
  SimScreenSource,
  SimScreenshotFormat,
  SimSignerAccount,
  SimUiElement,
} from "@jagentdesk/protocol/simulator/rpc-schemas";
import { findExecutable } from "../../executable-resolution/executable-resolution.js";
import type { SimScreenshot } from "../simulator/simulator-service.js";
import { Adb, isWifiSerial, resolveAdbPath, type AdbDeviceEntry } from "./adb.js";
import { ANDROID_KEYCODES, AndroidDevice } from "./android.js";
import { DeviceError } from "./errors.js";
import { GoIos, resolveGoIos, type GoIosDevice } from "./go-ios.js";
import { SCREEN_MAX_DIM, encodeJpeg, jpegFrame, type JpegFrame } from "./image.js";
import { IosDevice, IosTunnelAgent, iosMajorVersion } from "./ios.js";
import { MotionAction, ScrcpySession, resolveScrcpyServer } from "./scrcpy.js";
import { PhysicalDeviceStore } from "./store.js";
import { WDA_BUTTONS, openMjpegStream } from "./wda.js";
import {
  defaultFetchBytes,
  ensureWdaIpa,
  type DeviceSigner,
  type FetchBytes,
} from "./wda-prepare.js";

// Daemon-wide owner of physical devices (spec 27, ADR-0033): discovery, the per-device control
// switch, one screen source per device shared by every client and agent, and the agent grants.
// Simulators stay with SimulatorService; this hub only answers for `android:serial:*`/`ios:*`.

export const ANDROID_UDID_PREFIX = "android:serial:";
export const IOS_UDID_PREFIX = "ios:";

export function isPhysicalUdid(udid: string): boolean {
  return udid.startsWith(ANDROID_UDID_PREFIX) || udid.startsWith(IOS_UDID_PREFIX);
}

// Spec 27.3 / ADR-0033: only physical devices start with control off. Emulators found by adb keep
// simulator behaviour (controllable without enabling).
export function controlRefusal(device: SimDevice, controlEnabled: boolean): DeviceError | null {
  if (device.kind !== "physical" || controlEnabled) return null;
  return new DeviceError(
    "control_disabled",
    `Control of ${device.name} is off. Turn on Enable control for it in Sims first.`,
  );
}

export interface PhysicalAvailability {
  adb: boolean;
  goIos: boolean;
  ffmpeg: boolean;
}

export interface ScreenFrameEvent extends JpegFrame {
  timestamp_ms: number;
}

export interface ScreenListener {
  onFrame(frame: ScreenFrameEvent): void;
  onEnd(reason: string): void;
}

interface ScreenSourceHandle {
  kind: SimScreenSource;
  scrcpy: ScrcpySession | null;
  stop(): void;
}

interface DeviceScreen {
  udid: string;
  listeners: Set<ScreenListener>;
  source: ScreenSourceHandle | null;
  starting: Promise<ScreenSourceHandle> | null;
  latest: ScreenFrameEvent | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
}

interface HostTools {
  adb: Adb | null;
  goIos: GoIos | null;
  tunnel: IosTunnelAgent | null;
  ffmpeg: string | null;
}

export type AgentDecision = "allow" | "deny";

const LIST_CACHE_MS = 1_500;
const IOS_PROBE_CACHE_MS = 2_000;
const TOOLS_RETRY_MS = 30_000;
const SOURCE_RESTART_MS = 2_500;
const SCREENCAP_MAX_FPS = 15;
const LATEST_FRAME_FRESH_MS = 1_000;
const SWIPE_STEP_MS = 16;

const ANDROID_STATE_LABEL: Record<AdbDeviceEntry["state"], string> = {
  device: "Connected",
  unauthorized: "Unauthorized",
  offline: "Offline",
  no_permissions: "No USB permission",
  other: "Unavailable",
};

function androidReadiness(entry: AdbDeviceEntry): SimReadiness {
  if (entry.state === "device") return "ready";
  if (entry.state === "unauthorized" || entry.state === "no_permissions") {
    return "needs_usb_debugging";
  }
  return "offline";
}

const NOT_READY_MESSAGE: Record<Exclude<SimReadiness, "ready">, string> = {
  needs_trust: "Unlock the device and tap Trust on the Trust This Computer prompt.",
  needs_unlock: "Unlock the device.",
  needs_developer_mode: "Turn on Developer Mode in Settings > Privacy & Security, then restart.",
  needs_wda: "Prepare the device to install WebDriverAgent.",
  wda_expired: "WebDriverAgent expired. Prepare the device again to re-sign it.",
  needs_usb_debugging: "Unlock the phone and accept the USB debugging prompt.",
  offline: "The device is offline. Reconnect the cable or Wi-Fi.",
};

function reuseTool<T extends { binary: string }>(
  previous: T | null,
  binary: string | null,
  create: (binary: string) => T,
): T | null {
  if (!binary) return null;
  if (previous && previous.binary === binary) return previous;
  return create(binary);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PhysicalDeviceHubOptions {
  jagentdeskHome: string;
  logger: pino.Logger;
  signer: DeviceSigner | null;
  fetchBytes?: FetchBytes;
  now?: () => number;
}

export class PhysicalDeviceHub {
  private readonly store: PhysicalDeviceStore;
  private readonly logger: pino.Logger;
  private readonly now: () => number;
  private readonly fetchBytes: FetchBytes;
  private tools: HostTools | null = null;
  private toolsResolvedAt = 0;
  private resolvingTools: Promise<HostTools> | null = null;
  private readonly androids = new Map<string, AndroidDevice>();
  private readonly ioses = new Map<string, IosDevice>();
  private readonly iosProbes = new Map<
    string,
    { at: number; readiness: SimReadiness; name: string }
  >();
  private devices: SimDevice[] = [];
  private listedAt = 0;
  private listing: Promise<SimDevice[]> | null = null;
  private readonly screens = new Map<string, DeviceScreen>();
  private readonly logChildren = new Map<string, Set<ChildProcess>>();
  private readonly agentDecisions = new Map<string, Map<string, AgentDecision>>();

  constructor(private readonly options: PhysicalDeviceHubOptions) {
    this.store = new PhysicalDeviceStore(options.jagentdeskHome);
    this.logger = options.logger.child({ module: "physical-devices" });
    this.now = options.now ?? Date.now;
    this.fetchBytes = options.fetchBytes ?? defaultFetchBytes;
  }

  // ── tools ──

  private async hostTools(): Promise<HostTools> {
    const stale =
      this.tools !== null &&
      (!this.tools.adb || !this.tools.goIos || !this.tools.ffmpeg) &&
      this.now() - this.toolsResolvedAt > TOOLS_RETRY_MS;
    if (this.tools && !stale) return this.tools;
    this.resolvingTools ??= this.resolveTools().finally(() => {
      this.resolvingTools = null;
    });
    return this.resolvingTools;
  }

  private async resolveTools(): Promise<HostTools> {
    await this.store.load();
    const [adbPath, goIosPath, ffmpeg] = await Promise.all([
      resolveAdbPath(this.options.jagentdeskHome),
      resolveGoIos(this.options.jagentdeskHome),
      findExecutable("ffmpeg"),
    ]);
    // Keep the instances a re-resolve finds unchanged: devices and the iOS tunnel hold them.
    const previous = this.tools;
    const adb = reuseTool(previous?.adb ?? null, adbPath, (bin) => new Adb(bin, this.logger));
    const goIos = reuseTool(
      previous?.goIos ?? null,
      goIosPath,
      (bin) => new GoIos(bin, this.logger),
    );
    let tunnel = previous?.tunnel ?? null;
    if (goIos !== (previous?.goIos ?? null)) {
      tunnel?.stop();
      tunnel = goIos ? new IosTunnelAgent(goIos, this.logger) : null;
    }
    this.tools = { adb, goIos, tunnel, ffmpeg };
    this.toolsResolvedAt = this.now();
    return this.tools;
  }

  async availability(): Promise<PhysicalAvailability> {
    const tools = await this.hostTools();
    return { adb: tools.adb !== null, goIos: tools.goIos !== null, ffmpeg: tools.ffmpeg !== null };
  }

  // ── discovery ──

  list(): Promise<SimDevice[]> {
    if (this.now() - this.listedAt < LIST_CACHE_MS) return Promise.resolve(this.devices);
    this.listing ??= this.discover().finally(() => {
      this.listing = null;
    });
    return this.listing;
  }

  private async discover(): Promise<SimDevice[]> {
    const tools = await this.hostTools();
    const [android, ios] = await Promise.all([
      tools.adb ? this.discoverAndroid(tools.adb) : Promise.resolve([]),
      tools.goIos && tools.tunnel
        ? this.discoverIos(tools.goIos, tools.tunnel)
        : Promise.resolve([]),
    ]);
    const devices = [...android, ...ios];
    const present = new Set(devices.map((device) => device.udid));
    for (const previous of this.devices) {
      if (!present.has(previous.udid)) this.forgetDevice(previous.udid, "device disconnected");
    }
    this.devices = devices;
    this.listedAt = this.now();
    for (const device of devices) this.resumeScreen(device);
    return devices;
  }

  private async discoverAndroid(adb: Adb): Promise<SimDevice[]> {
    const entries = await adb.devices().catch((error: unknown) => {
      this.logger.warn({ err: error }, "adb devices failed");
      return [];
    });
    return Promise.all(
      entries.map(async (entry) => {
        const udid = ANDROID_UDID_PREFIX + entry.serial;
        let device = this.androids.get(entry.serial);
        if (!device) {
          device = new AndroidDevice(adb, entry.serial);
          this.androids.set(entry.serial, device);
        }
        const info = entry.state === "device" ? await device.info().catch(() => null) : null;
        const isEmulator = info?.isEmulator ?? entry.serial.startsWith("emulator-");
        const readiness = androidReadiness(entry);
        const model = info?.model ?? entry.model ?? "";
        let connection: SimDevice["connection"] = null;
        if (!isEmulator) connection = isWifiSerial(entry.serial) ? "wifi" : "usb";
        return {
          udid,
          name: info?.name ?? entry.model ?? entry.serial,
          state: ANDROID_STATE_LABEL[entry.state],
          isBooted: readiness === "ready",
          runtime: info?.osVersion ? `Android ${info.osVersion}` : "Android",
          deviceType: model,
          slimState: "unknown",
          platform: "android",
          kind: isEmulator ? "emulator" : "physical",
          connection,
          // Spec 27.3: the switch is for physical devices; emulators stay controllable.
          controlEnabled: isEmulator || this.store.isControlEnabled(udid),
          readiness,
          osVersion: info?.osVersion ?? "",
          model,
        } satisfies SimDevice;
      }),
    );
  }

  private async discoverIos(goIos: GoIos, tunnel: IosTunnelAgent): Promise<SimDevice[]> {
    const listed = await goIos.list().catch((error: unknown) => {
      this.logger.warn({ err: error }, "go-ios list failed");
      return [] as GoIosDevice[];
    });
    return Promise.all(listed.map((entry) => this.describeIos(goIos, tunnel, entry)));
  }

  private async describeIos(
    goIos: GoIos,
    tunnel: IosTunnelAgent,
    entry: GoIosDevice,
  ): Promise<SimDevice> {
    const udid = IOS_UDID_PREFIX + entry.udid;
    const major = iosMajorVersion(entry.productVersion);
    let device = this.ioses.get(entry.udid);
    if (!device) {
      device = new IosDevice(entry.udid, major, {
        goIos,
        tunnel,
        store: this.store,
        logger: this.logger,
      });
      this.ioses.set(entry.udid, device);
    }
    let probe = this.iosProbes.get(udid);
    if (!probe || this.now() - probe.at > IOS_PROBE_CACHE_MS) {
      const result = await device.probe(this.now());
      probe = { at: this.now(), readiness: result.readiness, name: result.deviceName };
      this.iosProbes.set(udid, probe);
    }
    const os = entry.productType.startsWith("iPad") && major >= 13 ? "iPadOS" : "iOS";
    return {
      udid,
      name: probe.name || entry.productType || "iOS device",
      state: probe.readiness === "ready" ? "Connected" : "Needs attention",
      isBooted: probe.readiness !== "offline",
      runtime: entry.productVersion ? `${os} ${entry.productVersion}` : os,
      deviceType: entry.productType,
      slimState: "unknown",
      platform: "ios",
      kind: "physical",
      connection: entry.connectionType === "Network" ? "wifi" : "usb",
      controlEnabled: this.store.isControlEnabled(udid),
      readiness: probe.readiness,
      osVersion: entry.productVersion,
      model: entry.productType,
    };
  }

  private async find(udid: string): Promise<SimDevice> {
    let device = this.devices.find((candidate) => candidate.udid === udid);
    if (!device) {
      this.listedAt = 0;
      device = (await this.list()).find((candidate) => candidate.udid === udid);
    }
    if (!device) throw new DeviceError("device_not_found", `No connected device ${udid}`);
    return device;
  }

  // ── control switch (spec 27.3) ──

  async requireControl(udid: string): Promise<SimDevice> {
    await this.hostTools();
    const device = await this.find(udid);
    const refusal = controlRefusal(device, this.store.isControlEnabled(udid));
    if (refusal) throw refusal;
    return device;
  }

  // Whether the hub may drive the device right now (screen restarts check this).
  private isControllable(udid: string): boolean {
    const device = this.devices.find((candidate) => candidate.udid === udid);
    if (!device) return false;
    return controlRefusal(device, this.store.isControlEnabled(udid)) === null;
  }

  private async requirePhysical(udid: string): Promise<SimDevice> {
    const device = await this.find(udid);
    if (device.kind !== "physical") {
      throw new DeviceError(
        "unsupported_on_platform",
        "Emulators are always controllable; only phones and tablets have a control switch",
      );
    }
    return device;
  }

  private async requireReady(udid: string): Promise<SimDevice> {
    const device = await this.requireControl(udid);
    const readiness = device.readiness ?? "ready";
    // iOS WDA readiness is checked when WDA starts; Android needs an authorised adb transport.
    if (device.platform === "android" && readiness !== "ready") {
      throw new DeviceError("device_not_ready", NOT_READY_MESSAGE[readiness]);
    }
    if (device.platform === "ios" && (readiness === "needs_trust" || readiness === "offline")) {
      throw new DeviceError("device_not_ready", NOT_READY_MESSAGE[readiness]);
    }
    return device;
  }

  isControlEnabled(udid: string): boolean {
    const device = this.devices.find((candidate) => candidate.udid === udid);
    if (device && device.kind !== "physical") return true;
    return this.store.isControlEnabled(udid);
  }

  async enable(udid: string): Promise<void> {
    await this.hostTools();
    await this.requirePhysical(udid);
    await this.store.setControlEnabled(udid, true, this.now());
    this.logger.info({ udid }, "physical device control enabled");
    this.patchDevice(udid, { controlEnabled: true });
  }

  async disable(udid: string): Promise<void> {
    await this.hostTools();
    await this.requirePhysical(udid);
    await this.store.setControlEnabled(udid, false, this.now());
    this.logger.info({ udid }, "physical device control disabled");
    this.patchDevice(udid, { controlEnabled: false });
    this.forgetDevice(udid, "control_disabled");
  }

  private patchDevice(udid: string, patch: Partial<SimDevice>): void {
    this.devices = this.devices.map((device) =>
      device.udid === udid ? { ...device, ...patch } : device,
    );
  }

  // Stops everything running against a device (disabled, unplugged).
  private forgetDevice(udid: string, reason: string): void {
    const screen = this.screens.get(udid);
    if (screen) {
      if (screen.restartTimer) clearTimeout(screen.restartTimer);
      screen.source?.stop();
      for (const listener of screen.listeners) listener.onEnd(reason);
      this.screens.delete(udid);
    }
    for (const child of this.logChildren.get(udid) ?? []) child.kill();
    this.logChildren.delete(udid);
    if (udid.startsWith(IOS_UDID_PREFIX))
      this.ioses.get(udid.slice(IOS_UDID_PREFIX.length))?.stop();
  }

  // ── backends ──

  private android(device: SimDevice): AndroidDevice {
    const serial = device.udid.slice(ANDROID_UDID_PREFIX.length);
    const backend = this.androids.get(serial);
    if (!backend) throw new DeviceError("device_not_found", `No connected device ${device.udid}`);
    return backend;
  }

  private ios(device: SimDevice): IosDevice {
    const backend = this.ioses.get(device.udid.slice(IOS_UDID_PREFIX.length));
    if (!backend) throw new DeviceError("device_not_found", `No connected device ${device.udid}`);
    return backend;
  }

  // ── screen (spec 27.5) ──

  async subscribeScreen(
    udid: string,
    listener: ScreenListener,
  ): Promise<{ source: SimScreenSource; unsubscribe: () => void }> {
    await this.requireReady(udid);
    let screen = this.screens.get(udid);
    if (!screen) {
      screen = {
        udid,
        listeners: new Set(),
        source: null,
        starting: null,
        latest: null,
        restartTimer: null,
      };
      this.screens.set(udid, screen);
    }
    screen.listeners.add(listener);
    const owned = screen;
    try {
      const source = owned.source ?? (await this.startSource(owned));
      // scrcpy only encodes when the screen changes: a late subscriber starts from the last frame.
      const latest = owned.latest;
      if (latest) queueMicrotask(() => listener.onFrame(latest));
      return {
        source: source.kind,
        unsubscribe: () => this.removeListener(owned, listener),
      };
    } catch (error) {
      this.removeListener(owned, listener);
      throw error;
    }
  }

  private removeListener(screen: DeviceScreen, listener: ScreenListener): void {
    screen.listeners.delete(listener);
    if (screen.listeners.size > 0) return;
    if (screen.restartTimer) clearTimeout(screen.restartTimer);
    screen.source?.stop();
    screen.source = null;
    if (this.screens.get(screen.udid) === screen) this.screens.delete(screen.udid);
  }

  private startSource(screen: DeviceScreen): Promise<ScreenSourceHandle> {
    screen.starting ??= this.openSource(screen)
      .then((source) => {
        if (screen.listeners.size === 0) {
          source.stop();
          return source;
        }
        screen.source = source;
        return source;
      })
      .finally(() => {
        screen.starting = null;
      });
    return screen.starting;
  }

  private async openSource(screen: DeviceScreen): Promise<ScreenSourceHandle> {
    const device = await this.find(screen.udid);
    if (device.platform === "ios") return this.openWdaSource(screen, device);
    return this.openAndroidSource(screen, device);
  }

  private emit(screen: DeviceScreen, frame: JpegFrame): void {
    const event: ScreenFrameEvent = { ...frame, timestamp_ms: this.now() };
    screen.latest = event;
    for (const listener of screen.listeners) listener.onFrame(event);
  }

  private onSourceExit(screen: DeviceScreen, handle: ScreenSourceHandle, reason: string): void {
    if (screen.source !== handle) return;
    screen.source = null;
    this.logger.info({ udid: screen.udid, reason }, "screen source ended");
    this.scheduleRestart(screen);
  }

  // Lock screens, cable wiggles and WDA crashes end a source; while someone watches, retry.
  private scheduleRestart(screen: DeviceScreen): void {
    if (screen.listeners.size === 0 || screen.restartTimer) return;
    screen.restartTimer = setTimeout(() => {
      screen.restartTimer = null;
      if (screen.listeners.size === 0 || screen.source) return;
      if (!this.isControllable(screen.udid)) return;
      void this.startSource(screen).catch((error: unknown) => {
        this.logger.debug({ err: error, udid: screen.udid }, "screen restart failed");
        this.scheduleRestart(screen);
      });
    }, SOURCE_RESTART_MS);
  }

  private resumeScreen(device: SimDevice): void {
    const screen = this.screens.get(device.udid);
    if (!screen || screen.source || screen.starting) return;
    if (device.readiness === "ready") this.scheduleRestart(screen);
  }

  private async openAndroidSource(
    screen: DeviceScreen,
    device: SimDevice,
  ): Promise<ScreenSourceHandle> {
    const tools = await this.hostTools();
    const backend = this.android(device);
    if (tools.adb && tools.ffmpeg && resolveScrcpyServer()) {
      try {
        let handle: ScreenSourceHandle | null = null;
        const session = await ScrcpySession.start({
          adb: tools.adb,
          serial: backend.serial,
          ffmpeg: tools.ffmpeg,
          logger: this.logger,
          onFrame: (frame) => this.emit(screen, frame),
          onExit: (reason) => {
            if (handle) this.onSourceExit(screen, handle, reason);
          },
        });
        handle = { kind: "scrcpy", scrcpy: session, stop: () => session.stop() };
        return handle;
      } catch (error) {
        this.logger.warn({ err: error, udid: device.udid }, "scrcpy failed; using screencap");
      }
    }
    return this.openScreencapSource(screen, backend, tools);
  }

  private openScreencapSource(
    screen: DeviceScreen,
    backend: AndroidDevice,
    tools: HostTools,
  ): ScreenSourceHandle {
    const state = { stopped: false };
    const handle: ScreenSourceHandle = {
      kind: "screencap",
      scrcpy: null,
      stop: () => {
        state.stopped = true;
      },
    };
    const loop = async () => {
      while (!state.stopped) {
        const started = this.now();
        try {
          const frame = await encodeJpeg(await backend.screencapPng(), SCREEN_MAX_DIM, tools);
          if (!state.stopped) this.emit(screen, frame);
        } catch (error) {
          if (!state.stopped) this.onSourceExit(screen, handle, String(error));
          return;
        }
        await delay(Math.max(0, 1000 / SCREENCAP_MAX_FPS - (this.now() - started)));
      }
    };
    void loop();
    return handle;
  }

  private async openWdaSource(
    screen: DeviceScreen,
    device: SimDevice,
  ): Promise<ScreenSourceHandle> {
    const backend = this.ios(device);
    const client = await backend.wda();
    const port = backend.mjpegPort;
    if (port === null) throw new DeviceError("device_not_ready", "WebDriverAgent is not running");
    let fitted = false;
    let handle: ScreenSourceHandle | null = null;
    const stream = openMjpegStream({
      port,
      onFrame: (jpeg) => {
        const frame = jpegFrame(jpeg);
        if (!frame) return;
        if (!fitted) {
          fitted = true;
          void client.fitMjpeg(frame.width, frame.height).catch(() => {});
        }
        this.emit(screen, frame);
      },
      onEnd: (reason) => {
        if (handle) this.onSourceExit(screen, handle, reason);
      },
    });
    handle = { kind: "wda-mjpeg", scrcpy: null, stop: () => stream.close() };
    return handle;
  }

  // ── operations (all behind the control switch) ──

  async screenshot(
    udid: string,
    opts: { format?: SimScreenshotFormat; maxDim?: number },
  ): Promise<SimScreenshot> {
    const device = await this.requireReady(udid);
    const maxDim = Math.min(opts.maxDim ?? SCREEN_MAX_DIM, SCREEN_MAX_DIM * 2);
    const latest = this.screens.get(udid)?.latest;
    const fresh = latest && this.now() - latest.timestamp_ms < LATEST_FRAME_FRESH_MS;
    if (opts.format !== "png" && fresh && Math.max(latest.width, latest.height) <= maxDim) {
      return {
        base64: latest.jpeg.toString("base64"),
        mimeType: "image/jpeg",
        width: latest.width,
        height: latest.height,
      };
    }
    const png =
      device.platform === "ios"
        ? await (await this.ios(device).wda()).screenshotPng()
        : await this.android(device).screencapPng();
    if (opts.format === "png") {
      const frame = { base64: png.toString("base64"), mimeType: "image/png" as const };
      const width = png.length >= 24 ? png.readUInt32BE(16) : 0;
      const height = png.length >= 24 ? png.readUInt32BE(20) : 0;
      return { ...frame, width, height };
    }
    const frame = await encodeJpeg(png, maxDim, await this.hostTools());
    return {
      base64: frame.jpeg.toString("base64"),
      mimeType: "image/jpeg",
      width: frame.width,
      height: frame.height,
    };
  }

  // Ratio coordinates (0..1 of the viewed frame) → device pixels on Android.
  private async androidPixels(
    device: SimDevice,
    x: number,
    y: number,
  ): Promise<{ x: number; y: number }> {
    const natural = await this.android(device).displaySize();
    const latest = this.screens.get(device.udid)?.latest;
    const landscape = latest ? latest.width > latest.height : false;
    const width = landscape
      ? Math.max(natural.width, natural.height)
      : Math.min(natural.width, natural.height);
    const height = landscape
      ? Math.min(natural.width, natural.height)
      : Math.max(natural.width, natural.height);
    return { x: x * width, y: y * height };
  }

  private liveScrcpy(udid: string): ScrcpySession | null {
    const session = this.screens.get(udid)?.source?.scrcpy ?? null;
    return session?.size ? session : null;
  }

  async tap(udid: string, x: number, y: number, coords: SimCoords = "device"): Promise<void> {
    const device = await this.requireReady(udid);
    if (device.platform === "ios") {
      const client = await this.ios(device).wda();
      const point = coords === "ratio" ? await this.iosPoints(client, x, y) : { x, y };
      await client.tap(point.x, point.y);
      return;
    }
    const scrcpy = coords === "ratio" ? this.liveScrcpy(udid) : null;
    if (scrcpy?.size) {
      const vx = x * scrcpy.size.width;
      const vy = y * scrcpy.size.height;
      scrcpy.touch(MotionAction.Down, vx, vy);
      scrcpy.touch(MotionAction.Up, vx, vy);
      return;
    }
    const point = coords === "ratio" ? await this.androidPixels(device, x, y) : { x, y };
    await this.android(device).tap(point.x, point.y);
  }

  private async iosPoints(
    client: Awaited<ReturnType<IosDevice["wda"]>>,
    x: number,
    y: number,
  ): Promise<{ x: number; y: number }> {
    const size = await client.windowSize();
    return { x: x * size.width, y: y * size.height };
  }

  async swipe(
    udid: string,
    from: { x: number; y: number },
    to: { x: number; y: number },
    durationMs = 300,
    coords: SimCoords = "device",
  ): Promise<void> {
    const device = await this.requireReady(udid);
    if (device.platform === "ios") {
      const client = await this.ios(device).wda();
      const a = coords === "ratio" ? await this.iosPoints(client, from.x, from.y) : from;
      const b = coords === "ratio" ? await this.iosPoints(client, to.x, to.y) : to;
      await client.drag(a.x, a.y, b.x, b.y, durationMs);
      return;
    }
    const scrcpy = coords === "ratio" ? this.liveScrcpy(udid) : null;
    if (scrcpy?.size) {
      await this.scrcpyDrag(scrcpy, from, to, durationMs);
      return;
    }
    const a = coords === "ratio" ? await this.androidPixels(device, from.x, from.y) : from;
    const b = coords === "ratio" ? await this.androidPixels(device, to.x, to.y) : to;
    await this.android(device).swipe(a.x, a.y, b.x, b.y, durationMs);
  }

  // A press-move-release gesture in ratio coordinates; the same point twice is a long press.
  private async scrcpyDrag(
    scrcpy: ScrcpySession,
    from: { x: number; y: number },
    to: { x: number; y: number },
    durationMs: number,
  ): Promise<void> {
    const size = scrcpy.size;
    if (!size) return;
    const steps = Math.max(1, Math.round(durationMs / SWIPE_STEP_MS));
    scrcpy.touch(MotionAction.Down, from.x * size.width, from.y * size.height);
    for (let step = 1; step <= steps; step += 1) {
      await delay(SWIPE_STEP_MS);
      const t = step / steps;
      const x = (from.x + (to.x - from.x) * t) * size.width;
      const y = (from.y + (to.y - from.y) * t) * size.height;
      scrcpy.touch(MotionAction.Move, x, y);
    }
    scrcpy.touch(MotionAction.Up, to.x * size.width, to.y * size.height);
  }

  async inputText(udid: string, text: string): Promise<void> {
    const device = await this.requireReady(udid);
    if (device.platform === "ios") {
      await (await this.ios(device).wda()).type(text);
      return;
    }
    const scrcpy = this.liveScrcpy(udid);
    if (scrcpy) scrcpy.text(text);
    else await this.android(device).text(text);
  }

  async button(udid: string, button: SimButton): Promise<void> {
    const device = await this.requireReady(udid);
    if (device.platform === "ios") {
      await this.iosButton(device, button);
      return;
    }
    const scrcpy = this.liveScrcpy(udid);
    if (button === "rotate") {
      if (scrcpy) scrcpy.rotate();
      else await this.android(device).rotate();
      return;
    }
    const keycode = ANDROID_KEYCODES[button];
    if (keycode === undefined) {
      throw new DeviceError("unsupported_on_platform", `Android devices have no ${button} button`);
    }
    if (scrcpy) scrcpy.key(keycode);
    else await this.android(device).key(keycode);
  }

  private async iosButton(device: SimDevice, button: SimButton): Promise<void> {
    const client = await this.ios(device).wda();
    if (button === "lock" || button === "power") {
      await client.lock();
      return;
    }
    if (button === "home") {
      await client.home();
      return;
    }
    if (button === "volume-up" || button === "volume-down") {
      await client.pressButton(WDA_BUTTONS[button]);
      return;
    }
    throw new DeviceError(
      "unsupported_on_platform",
      `${button} is not available on a physical iPhone or iPad; use home, lock or volume`,
    );
  }

  async describeUi(udid: string): Promise<SimUiElement[]> {
    const device = await this.requireReady(udid);
    if (device.platform === "ios") return (await this.ios(device).wda()).source();
    return this.android(device).describeUi();
  }

  async installApp(udid: string, appPath: string): Promise<void> {
    const device = await this.requireReady(udid);
    if (device.platform === "ios") {
      const { goIos } = await this.hostTools();
      if (!goIos) throw new DeviceError("tool_missing", "go-ios is not installed on this host");
      await goIos.install(device.udid.slice(IOS_UDID_PREFIX.length), appPath);
      return;
    }
    await this.android(device).installApp(appPath);
  }

  async launchApp(udid: string, bundleId: string, terminateExisting = false): Promise<void> {
    const device = await this.requireReady(udid);
    if (device.platform === "ios") {
      const { goIos } = await this.hostTools();
      if (!goIos) throw new DeviceError("tool_missing", "go-ios is not installed on this host");
      await goIos.launch(device.udid.slice(IOS_UDID_PREFIX.length), bundleId, terminateExisting);
      return;
    }
    await this.android(device).launchApp(bundleId, terminateExisting);
  }

  async terminateApp(udid: string, bundleId: string): Promise<void> {
    const device = await this.requireReady(udid);
    if (device.platform === "ios") {
      const { goIos } = await this.hostTools();
      if (!goIos) throw new DeviceError("tool_missing", "go-ios is not installed on this host");
      await goIos.kill(device.udid.slice(IOS_UDID_PREFIX.length), bundleId);
      return;
    }
    await this.android(device).terminateApp(bundleId);
  }

  async openUrl(udid: string, url: string): Promise<void> {
    const device = await this.requireReady(udid);
    if (device.platform === "ios") {
      await (await this.ios(device).wda()).openUrl(url);
      return;
    }
    await this.android(device).openUrl(url);
  }

  // Live log stream (logcat / syslog); killed when control is turned off.
  async spawnLogs(udid: string): Promise<ChildProcess> {
    const device = await this.requireReady(udid);
    let child: ChildProcess;
    if (device.platform === "ios") {
      const { goIos } = await this.hostTools();
      if (!goIos) throw new DeviceError("tool_missing", "go-ios is not installed on this host");
      child = goIos.syslog(device.udid.slice(IOS_UDID_PREFIX.length));
    } else {
      child = this.android(device).streamLogs();
    }
    let set = this.logChildren.get(udid);
    if (!set) {
      set = new Set();
      this.logChildren.set(udid, set);
    }
    const owned = set;
    owned.add(child);
    child.on("exit", () => owned.delete(child));
    return child;
  }

  // The last `lines` log lines, for the agent's sim_logs.
  async recentLogs(udid: string, lines: number): Promise<string> {
    const device = await this.requireReady(udid);
    if (device.platform === "android") return this.android(device).recentLogs(lines);
    const child = await this.spawnLogs(udid);
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    await delay(3_000);
    child.kill();
    return output.split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
  }

  // ── Android wireless debugging (spec 27.1) ──

  async pairWireless(input: {
    host: string;
    pairingPort: number;
    pairingCode: string;
    connectPort: number;
  }): Promise<string> {
    const { adb } = await this.hostTools();
    if (!adb) throw new DeviceError("tool_missing", "adb is not installed on this host");
    if (!/^[A-Za-z0-9.:\-[\]]+$/.test(input.host)) {
      throw new Error("Enter the IP address shown under Wireless debugging");
    }
    if (!/^\d{6}$/.test(input.pairingCode.trim())) {
      throw new Error("The pairing code is the 6 digits shown on the phone");
    }
    const pairOut = await adb.run(
      ["pair", `${input.host}:${input.pairingPort}`, input.pairingCode.trim()],
      30_000,
    );
    if (!/Successfully paired/i.test(pairOut)) throw new Error(pairOut.trim() || "Pairing failed");
    const target = `${input.host}:${input.connectPort}`;
    const connectOut = await adb.run(["connect", target], 30_000);
    if (!/connected to/i.test(connectOut)) throw new Error(connectOut.trim() || "Connect failed");
    this.listedAt = 0;
    return ANDROID_UDID_PREFIX + target;
  }

  // ── iOS Prepare device (spec 27.4) ──

  async signerAccounts(): Promise<SimSignerAccount[]> {
    if (!this.options.signer) return [];
    return this.options.signer.listAccounts();
  }

  async prepare(
    udid: string,
    accountId: string | undefined,
    onProgress: (
      step: "download" | "sign" | "install" | "launch" | "done",
      message: string,
    ) => void,
  ): Promise<{ bundleId: string; expiresAt_ms: number }> {
    const device = await this.requireControl(udid);
    if (device.platform !== "ios") {
      throw new DeviceError("unsupported_on_platform", "Prepare device is for iPhone and iPad");
    }
    const signer = this.options.signer;
    if (!signer) {
      throw new DeviceError(
        "sideload_unavailable",
        "Signing with an Apple account is not available on this host yet",
      );
    }
    const accounts = await signer.listAccounts();
    if (accounts.length === 0) {
      throw new DeviceError("no_apple_account", "Add an Apple account in Sideload first");
    }
    const onlyAccount = accounts.length === 1 ? accounts[0] : undefined;
    const account = accountId
      ? accounts.find((candidate) => candidate.id === accountId)
      : onlyAccount;
    if (!account)
      throw new DeviceError("account_required", "Choose the Apple account to sign with");
    onProgress("download", "Downloading WebDriverAgent");
    const ipaPath = await ensureWdaIpa(this.options.jagentdeskHome, this.fetchBytes);
    onProgress("sign", `Signing WebDriverAgent with ${account.label}`);
    const deviceUdid = udid.slice(IOS_UDID_PREFIX.length);
    const signed = await signer.signAndInstall({
      accountId: account.id,
      deviceUdid,
      ipaPath,
      autoRefresh: true,
    });
    onProgress("install", "WebDriverAgent installed");
    await this.store.setWda(
      udid,
      {
        bundleId: signed.bundleId,
        accountId: account.id,
        expiresAt_ms: signed.expiresAt_ms,
        installedAt_ms: this.now(),
      },
      this.now(),
    );
    const backend = this.ios(device);
    backend.lastWdaFailure = null;
    this.iosProbes.delete(udid);
    onProgress("launch", "Starting WebDriverAgent");
    await backend.wda();
    onProgress("done", "Device ready");
    return { bundleId: signed.bundleId, expiresAt_ms: signed.expiresAt_ms };
  }

  // ── agent grants (spec 27.6): once per agent session per device ──

  agentDecision(agentId: string, udid: string): AgentDecision | null {
    return this.agentDecisions.get(agentId)?.get(udid) ?? null;
  }

  recordAgentDecision(agentId: string, udid: string, decision: AgentDecision): void {
    let decisions = this.agentDecisions.get(agentId);
    if (!decisions) {
      decisions = new Map();
      this.agentDecisions.set(agentId, decisions);
    }
    decisions.set(udid, decision);
  }

  forgetAgent(agentId: string): void {
    this.agentDecisions.delete(agentId);
  }

  async deviceName(udid: string): Promise<string> {
    return (await this.find(udid)).name;
  }

  dispose(): void {
    for (const udid of Array.from(this.screens.keys())) this.forgetDevice(udid, "daemon stopping");
    for (const device of this.ioses.values()) device.stop();
    this.tools?.tunnel?.stop();
  }
}
