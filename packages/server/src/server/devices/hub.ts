import type { ChildProcess } from "node:child_process";
import path from "node:path";
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
import { cabledIosDevices, GoIos, resolveGoIos, type GoIosDevice } from "./go-ios.js";
import { SCREEN_MAX_DIM, encodeJpeg, jpegFrame, type JpegFrame } from "./image.js";
import { IosDevice, IosTunnelAgent, iosMajorVersion } from "./ios.js";
import { PolledScreen, iosScreenPlan, screenAvailable } from "./ios-screen.js";
import { MotionAction, ScrcpySession, resolveScrcpyServer } from "./scrcpy.js";
import { PhysicalDeviceStore } from "./store.js";
import { WDA_BUTTONS, openMjpegStream, type WdaClient } from "./wda.js";
import { chooseSignerAccount, iosTouchPlan, type TouchCaller } from "./wda-auto-prepare.js";
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
  needs_wda: "Touch is not enabled yet. Tap the screen or Enable touch in Sims to set it up.",
  wda_expired: "Touch expired. Tap the screen or Enable touch in Sims to renew it.",
  needs_usb_debugging: "Unlock the phone and accept the USB debugging prompt.",
  offline: "The device is offline. Reconnect the cable.",
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

export type PrepareStep = "download" | "sign" | "install" | "launch" | "done";
export type PrepareProgress = (step: PrepareStep, message: string) => void;

interface PrepareResult {
  bundleId: string;
  expiresAt_ms: number;
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
  // One WebDriverAgent prepare per device at a time; a second touch or agent waits for it.
  private readonly preparing = new Map<string, Promise<PrepareResult>>();

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
    const described = await Promise.all(
      entries.map(async (entry): Promise<SimDevice | null> => {
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
        // Spec 27.1: physical Android devices over a USB cable only. A phone someone connected
        // over the network by hand outside JAgentDesk is not listed.
        if (!isEmulator && isWifiSerial(entry.serial)) return null;
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
          connection: isEmulator ? null : "usb",
          // Spec 27.3: the switch is for physical devices; emulators stay controllable.
          controlEnabled: isEmulator || this.store.isControlEnabled(udid),
          readiness,
          screenAvailable: screenAvailable("android", readiness),
          osVersion: info?.osVersion ?? "",
          model,
        } satisfies SimDevice;
      }),
    );
    return described.filter((device): device is SimDevice => device !== null);
  }

  private async discoverIos(goIos: GoIos, tunnel: IosTunnelAgent): Promise<SimDevice[]> {
    const listed = await goIos.list().catch((error: unknown) => {
      this.logger.warn({ err: error }, "go-ios list failed");
      return [] as GoIosDevice[];
    });
    return Promise.all(
      cabledIosDevices(listed).map((entry) => this.describeIos(goIos, tunnel, entry)),
    );
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
        developerImageDir: path.join(this.options.jagentdeskHome, "devices", "ddi"),
      });
      this.ioses.set(entry.udid, device);
    }
    let probe = this.iosProbes.get(udid);
    if (!probe || this.now() - probe.at > IOS_PROBE_CACHE_MS) {
      await this.syncWdaExpiry(udid);
      const result = await device.probe(this.now());
      probe = { at: this.now(), readiness: result.readiness, name: result.deviceName };
      this.iosProbes.set(udid, probe);
    }
    const os = entry.productType.startsWith("iPad") && major >= 13 ? "iPadOS" : "iOS";
    return {
      udid,
      name: probe.name || entry.productType || "iOS device",
      // Touch not set up yet still shows the screen (spec 27.5): the device is connected.
      state: screenAvailable("ios", probe.readiness) ? "Connected" : "Needs attention",
      isBooted: probe.readiness !== "offline",
      runtime: entry.productVersion ? `${os} ${entry.productVersion}` : os,
      deviceType: entry.productType,
      slimState: "unknown",
      platform: "ios",
      kind: "physical",
      connection: "usb",
      controlEnabled: this.store.isControlEnabled(udid),
      readiness: probe.readiness,
      screenAvailable: screenAvailable("ios", probe.readiness),
      osVersion: entry.productVersion,
      model: entry.productType,
    };
  }

  // Sideload's auto refresh (26.6) re-signs WDA with a new expiry; the readiness here follows it.
  private async syncWdaExpiry(udid: string): Promise<void> {
    const install = this.store.wda(udid);
    const signer = this.options.signer;
    if (!install || !signer?.installedExpiry) return;
    const expiresAt_ms = await signer
      .installedExpiry(udid.slice(IOS_UDID_PREFIX.length), install.bundleId)
      .catch(() => null);
    if (expiresAt_ms === null || expiresAt_ms <= install.expiresAt_ms) return;
    await this.store.setWda(udid, { ...install, expiresAt_ms }, this.now());
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
    // iOS: the screen (screenshot service) and WDA both need trust and Developer Mode; a missing
    // or expired WDA only matters to touch (iosDriver).
    if (
      device.platform === "ios" &&
      (readiness === "needs_trust" ||
        readiness === "offline" ||
        readiness === "needs_developer_mode")
    ) {
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
    if (device.platform === "ios") return this.openIosSource(screen, device);
    return this.openAndroidSource(screen, device);
  }

  // Spec 27.5: WDA MJPEG when WDA runs, else the screenshot service right away (no Apple account);
  // an installed WDA is started alongside and takes over once it is up.
  private async openIosSource(
    screen: DeviceScreen,
    device: SimDevice,
  ): Promise<ScreenSourceHandle> {
    const backend = this.ios(device);
    const plan = iosScreenPlan({
      wdaRunning: backend.wdaRunning,
      readiness: device.readiness ?? "ready",
    });
    if (plan.source === "wda-mjpeg") {
      try {
        return await this.openWdaSource(screen, device);
      } catch (error) {
        this.logger.warn({ err: error, udid: device.udid }, "WDA MJPEG failed; using screenshots");
      }
    }
    const handle = await this.openIosScreenshotSource(screen, backend);
    if (plan.startWdaInBackground) {
      void backend
        .wda()
        .then(() => this.upgradeToWda(device.udid))
        .catch((error: unknown) => {
          this.logger.debug(
            { err: error, udid: device.udid },
            "WDA did not start; screenshots stay",
          );
        });
    }
    return handle;
  }

  private async openIosScreenshotSource(
    screen: DeviceScreen,
    backend: IosDevice,
  ): Promise<ScreenSourceHandle> {
    const tools = await this.hostTools();
    // The first frame decides whether the source works at all (Developer Disk Image, Developer
    // Mode, lock): its error goes back to the subscriber instead of a silent blank screen.
    const first = await encodeJpeg(await backend.screenshotImage(), SCREEN_MAX_DIM, tools);
    let handle: ScreenSourceHandle | null = null;
    const poller = new PolledScreen({
      capture: () => backend.screenshotImage(),
      encode: (image) => encodeJpeg(image, SCREEN_MAX_DIM, tools),
      onFrame: (frame) => this.emit(screen, frame),
      onEnd: (reason) => {
        if (handle) this.onSourceExit(screen, handle, reason);
      },
    });
    handle = { kind: "screencap", scrcpy: null, stop: () => poller.stop() };
    this.emit(screen, first);
    poller.start();
    return handle;
  }

  // WDA came up (background start, a touch, Enable touch): a screen still on screenshots
  // switches to the MJPEG stream without dropping its subscribers.
  private async upgradeToWda(udid: string): Promise<void> {
    const screen = this.screens.get(udid);
    if (!screen || screen.starting || screen.source?.kind !== "screencap") return;
    const previous = screen.source;
    const device = await this.find(udid).catch(() => null);
    if (!device || device.platform !== "ios") return;
    let next: ScreenSourceHandle;
    try {
      next = await this.openWdaSource(screen, device);
    } catch (error) {
      this.logger.debug({ err: error, udid }, "switch to WDA MJPEG failed; screenshots stay");
      return;
    }
    if (screen.listeners.size === 0 || screen.source !== previous) {
      next.stop();
      return;
    }
    screen.source = next;
    previous.stop();
    this.logger.info({ udid }, "screen switched to WDA MJPEG");
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
    const platform = device.platform === "android" ? "android" : "ios";
    if (screenAvailable(platform, device.readiness ?? "ready")) this.scheduleRestart(screen);
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
        ? await this.iosScreenshot(device)
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

  // WDA's screenshot when it runs, else the screenshot service: no WDA start, no Apple account.
  private async iosScreenshot(device: SimDevice): Promise<Buffer> {
    const backend = this.ios(device);
    if (backend.wdaRunning) {
      const client = await backend.wda();
      const png = await client.screenshotPng().catch(() => null);
      if (png) return png;
    }
    return backend.screenshotImage();
  }

  // Spec 27.4: the WDA client for a touch. WDA installed and in date → start it if needed;
  // otherwise the app gets wda_required (its "Enable touch" dialog prepares in place) and an
  // agent prepares now with the saved Apple account.
  private async iosDriver(device: SimDevice, caller: TouchCaller): Promise<WdaClient> {
    const backend = this.ios(device);
    const plan = iosTouchPlan({
      caller,
      wdaRunning: backend.wdaRunning,
      install: this.store.wda(device.udid),
      wdaInstalled: backend.wdaInstalled,
      lastWdaFailure: backend.lastWdaFailure,
      now_ms: this.now(),
    });
    if (plan === "ask_app") {
      throw new DeviceError("wda_required", `Touch is not enabled on ${device.name} yet.`);
    }
    if (plan === "prepare") await this.agentPrepare(device);
    let client: WdaClient;
    try {
      client = await backend.wda();
    } catch (error) {
      // The signature ran out between probes: the next touch sets WDA up again.
      if (backend.lastWdaFailure === "expired") {
        this.patchDevice(device.udid, { readiness: "wda_expired" });
        if (caller === "agent") {
          await this.agentPrepare(device);
          client = await backend.wda();
          void this.upgradeToWda(device.udid);
          return client;
        }
        throw new DeviceError("wda_required", `Touch on ${device.name} expired.`);
      }
      throw error;
    }
    void this.upgradeToWda(device.udid);
    return client;
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

  async tap(
    udid: string,
    x: number,
    y: number,
    coords: SimCoords = "device",
    caller: TouchCaller = "app",
  ): Promise<void> {
    const device = await this.requireReady(udid);
    if (device.platform === "ios") {
      const client = await this.iosDriver(device, caller);
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
    client: WdaClient,
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
    caller: TouchCaller = "app",
  ): Promise<void> {
    const device = await this.requireReady(udid);
    if (device.platform === "ios") {
      const client = await this.iosDriver(device, caller);
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

  async inputText(udid: string, text: string, caller: TouchCaller = "app"): Promise<void> {
    const device = await this.requireReady(udid);
    if (device.platform === "ios") {
      await (await this.iosDriver(device, caller)).type(text);
      return;
    }
    const scrcpy = this.liveScrcpy(udid);
    if (scrcpy) scrcpy.text(text);
    else await this.android(device).text(text);
  }

  async button(udid: string, button: SimButton, caller: TouchCaller = "app"): Promise<void> {
    const device = await this.requireReady(udid);
    if (device.platform === "ios") {
      await this.iosButton(device, button, caller);
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

  private async iosButton(
    device: SimDevice,
    button: SimButton,
    caller: TouchCaller,
  ): Promise<void> {
    if (!["lock", "power", "home", "volume-up", "volume-down"].includes(button)) {
      throw new DeviceError(
        "unsupported_on_platform",
        `${button} is not available on a physical iPhone or iPad; use home, lock or volume`,
      );
    }
    const client = await this.iosDriver(device, caller);
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

  async describeUi(udid: string, caller: TouchCaller = "app"): Promise<SimUiElement[]> {
    const device = await this.requireReady(udid);
    if (device.platform === "ios") return (await this.iosDriver(device, caller)).source();
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

  async openUrl(udid: string, url: string, caller: TouchCaller = "app"): Promise<void> {
    const device = await this.requireReady(udid);
    if (device.platform === "ios") {
      await (await this.iosDriver(device, caller)).openUrl(url);
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

  // ── iOS touch setup (spec 27.4): WebDriverAgent signed with the Apple account of Sideload ──

  async signerAccounts(): Promise<SimSignerAccount[]> {
    if (!this.options.signer) return [];
    return this.options.signer.listAccounts();
  }

  // The app's "Enable touch" (a first touch or the button): without accountId, one saved
  // account is used; several answer account_required (the dialog lists them); none answers
  // no_apple_account (the dialog shows Add Apple ID inline).
  async prepare(
    udid: string,
    accountId: string | undefined,
    onProgress: PrepareProgress,
  ): Promise<PrepareResult> {
    const device = await this.requireControl(udid);
    return this.prepareWith(device, { requestedId: accountId, caller: "app" }, onProgress);
  }

  // An agent touch on an iPhone without WDA (after the 27.6 card): prepare with the saved account,
  // or tell the agent what the user has to do.
  private async agentPrepare(device: SimDevice): Promise<void> {
    await this.prepareWith(device, { caller: "agent" }, (step, message) => {
      this.logger.info({ udid: device.udid, step }, message);
    });
  }

  private async prepareWith(
    device: SimDevice,
    input: { requestedId?: string; caller: TouchCaller },
    onProgress: PrepareProgress,
  ): Promise<PrepareResult> {
    if (device.platform !== "ios") {
      throw new DeviceError("unsupported_on_platform", "Touch setup is for iPhone and iPad");
    }
    const running = this.preparing.get(device.udid);
    if (running) {
      onProgress("sign", "Touch is already being set up on this device");
      return running;
    }
    const signer = this.options.signer;
    if (!signer) {
      throw new DeviceError(
        "sideload_unavailable",
        "Signing with an Apple account is not available on this host yet",
      );
    }
    const choice = chooseSignerAccount(await signer.listAccounts(), {
      requestedId: input.requestedId,
      previousId: this.store.wda(device.udid)?.accountId,
      caller: input.caller,
    });
    if (choice.kind === "none") {
      if (input.caller === "agent") {
        throw new DeviceError(
          "apple_account_required",
          `Touch on ${device.name} needs an Apple account to sign WebDriverAgent, and none is saved on this host. Ask the user to open ${device.name} in Sims, tap its screen and add an Apple ID in the dialog that opens, then try again.`,
        );
      }
      throw new DeviceError("no_apple_account", "No Apple account is saved on this host yet");
    }
    if (choice.kind === "choose") {
      if (input.caller === "agent") {
        throw new DeviceError(
          "account_required",
          `Several Apple accounts are saved on this host. Ask the user to open ${device.name} in Sims, tap its screen and choose the account for WebDriverAgent, then try again.`,
        );
      }
      throw new DeviceError("account_required", "Choose the Apple account to sign with");
    }
    const job = this.signWda(device, choice.account, signer, onProgress).finally(() => {
      this.preparing.delete(device.udid);
    });
    this.preparing.set(device.udid, job);
    return job;
  }

  private async signWda(
    device: SimDevice,
    account: SimSignerAccount,
    signer: DeviceSigner,
    onProgress: PrepareProgress,
  ): Promise<PrepareResult> {
    const udid = device.udid;
    onProgress("download", "Downloading WebDriverAgent");
    const ipaPath = await ensureWdaIpa(this.options.jagentdeskHome, this.fetchBytes);
    onProgress("sign", `Signing WebDriverAgent with ${account.label}`);
    const signed = await signer.signAndInstall({
      accountId: account.id,
      deviceUdid: udid.slice(IOS_UDID_PREFIX.length),
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
    backend.wdaInstalled = true;
    this.iosProbes.delete(udid);
    onProgress("launch", "Starting WebDriverAgent");
    await backend.wda();
    this.patchDevice(udid, { readiness: "ready", state: "Connected", screenAvailable: true });
    void this.upgradeToWda(udid);
    onProgress("done", "Touch is on");
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
