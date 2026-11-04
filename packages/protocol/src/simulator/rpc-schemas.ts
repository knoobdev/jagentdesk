import { z } from "zod";

// Wire schemas for SimFleet — the iOS-Simulator control plane. One control surface shared by
// the human UI and the agent tools: list/boot/shutdown, HID input (tap/swipe/type/buttons),
// accessibility-tree inspection, screenshots, app install/launch, deep links, and a density
// "slim" engine (disable background daemons so many simulators fit on one Mac). Mirrors
// docker/rpc-schemas.ts: every request carries a `type` literal + `requestId`; every response is
// `{ type, payload: { requestId, ...data, error } }`. Backed by the host `xcrun simctl` + `idb`.
// macOS-only; the daemon reports availability rather than erroring on other platforms.

// What the daemon can actually do, probed at request time. HID input (tap/swipe/type) + the
// element tree come from either `idb` (fast, native CoreSimulator HID) OR `maestro` (an
// on-device XCUITest driver that also works where idb_companion can't install, e.g. older
// macOS) — SimFleet prefers idb and falls back to Maestro. Without either it runs simctl-only
// (lifecycle + screenshot + logs + open-url still work). `xcode` is false when only the Command
// Line Tools are selected.
export const SimAvailabilitySchema = z.object({
  simctl: z.boolean(),
  idb: z.boolean(),
  maestro: z.boolean(),
  xcode: z.boolean(),
  // Spec 27: host tools behind physical devices. adb (Android, the host's own — never bundled),
  // go-ios (iOS), ffmpeg (Android H.264 → JPEG; without it the screen falls back to screencap).
  physical: z.object({ adb: z.boolean(), goIos: z.boolean(), ffmpeg: z.boolean() }).optional(),
});
export type SimAvailability = z.infer<typeof SimAvailabilitySchema>;

// "slim" = simslim-style density state, computed from the count of disabled background daemons.
// stock = untouched; slim = fully slimmed; partial = some disabled; unknown = not yet read.
export const SimSlimStateSchema = z.enum(["stock", "partial", "slim", "unknown"]);
export type SimSlimState = z.infer<typeof SimSlimStateSchema>;

export const SimPlatformSchema = z.enum(["ios", "android"]);
export type SimPlatform = z.infer<typeof SimPlatformSchema>;

export const SimDeviceKindSchema = z.enum(["simulator", "emulator", "physical"]);
export type SimDeviceKind = z.infer<typeof SimDeviceKindSchema>;

// Spec 27.1: physical devices are controlled over a cable only, so daemons send "usb" (or null
// for simulators and emulators). "wifi" stays accepted because the protocol never narrows:
// v0.9.48 daemons listed network-connected devices with it.
export const SimConnectionSchema = z.enum(["usb", "wifi"]);
export type SimConnection = z.infer<typeof SimConnectionSchema>;

// Spec 27.2: what still stands between a physical device and control, one step at a time.
export const SimReadinessSchema = z.enum([
  "ready",
  "needs_trust",
  "needs_unlock",
  "needs_developer_mode",
  "needs_wda",
  "wda_expired",
  "needs_usb_debugging",
  "offline",
]);
export type SimReadiness = z.infer<typeof SimReadinessSchema>;

export const SimDeviceSchema = z.object({
  udid: z.string(),
  name: z.string(),
  state: z.string(), // raw simctl state ("Booted" / "Shutdown" / "Creating" …)
  isBooted: z.boolean(),
  runtime: z.string(), // "iOS 18.5"
  deviceType: z.string(), // "iPhone 15 Pro"
  slimState: SimSlimStateSchema,
  // Spec 24.6 / 27.2. Absent = an iOS simulator (older daemons). Physical udids are
  // `ios:<udid>` and `android:serial:<serial>`.
  platform: SimPlatformSchema.optional(),
  kind: SimDeviceKindSchema.optional(),
  connection: SimConnectionSchema.nullable().optional(),
  // Spec 27.3: off by default for every adb/usbmux device; while off nothing is captured or driven.
  controlEnabled: z.boolean().optional(),
  readiness: SimReadinessSchema.optional(),
  // Spec 27.5: the live screen can be viewed once control is on. An iPhone without WebDriverAgent
  // (needs_wda / wda_expired) shows its screen through the screenshot service; only touch waits.
  // Absent from older daemons: viewable only when readiness is "ready".
  screenAvailable: z.boolean().optional(),
  osVersion: z.string().optional(),
  model: z.string().optional(),
});
export type SimDevice = z.infer<typeof SimDeviceSchema>;

// One node of the accessibility tree (from `idb ui describe-all`). frame is in points; an agent
// resolves a target by label/identifier and taps the frame center — no pixel guessing.
export const SimUiElementSchema = z.object({
  role: z.string(),
  label: z.string(),
  identifier: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  enabled: z.boolean(),
});
export type SimUiElement = z.infer<typeof SimUiElementSchema>;

export const SimActionSchema = z.enum(["boot", "shutdown", "erase", "delete"]);
export type SimAction = z.infer<typeof SimActionSchema>;

// home/lock/side-button/siri/apple-pay: iOS. back/app-switch/rotate: Android only. volume-up,
// volume-down and power reach physical devices (spec 27.5); a button a device lacks answers
// `unsupported_on_platform`.
export const SimButtonSchema = z.enum([
  "home",
  "lock",
  "side-button",
  "siri",
  "apple-pay",
  "back",
  "app-switch",
  "volume-up",
  "volume-down",
  "power",
  "rotate",
]);
export type SimButton = z.infer<typeof SimButtonSchema>;

function req<T extends string, S extends z.ZodRawShape>(type: T, extra: S) {
  return z.object({ type: z.literal(type), requestId: z.string(), ...extra });
}
function resp<T extends string, S extends z.ZodRawShape>(type: T, extra: S) {
  return z.object({
    type: z.literal(type),
    payload: z.object({ requestId: z.string(), error: z.string().nullable(), ...extra }),
  });
}
function push<T extends string, S extends z.ZodRawShape>(type: T, extra: S) {
  return z.object({
    type: z.literal(type),
    payload: z.object({ subscriptionId: z.string(), ...extra }),
  });
}

// ── list ──
export const SimListRequestSchema = req("simulator/list", {});
export const SimListResponseSchema = resp("simulator/list/response", {
  availability: SimAvailabilitySchema,
  devices: z.array(SimDeviceSchema),
});
export type SimListPayload = z.infer<typeof SimListResponseSchema>["payload"];

// ── lifecycle action (boot/shutdown/erase/delete) ──
export const SimActionRequestSchema = req("simulator/action", {
  udid: z.string(),
  action: SimActionSchema,
});
export const SimActionResponseSchema = resp("simulator/action/response", { udid: z.string() });
export type SimActionPayload = z.infer<typeof SimActionResponseSchema>["payload"];

// ── catalog: which device types can be created on which installed runtimes ──
// From `simctl list runtimes -j` (each available iOS runtime lists its supportedDeviceTypes), so
// a picker only ever offers valid (deviceType, runtime) pairs.
export const SimDeviceTypeSchema = z.object({
  identifier: z.string(), // "com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro"
  name: z.string(), // "iPhone 15 Pro"
  productFamily: z.string(), // "iPhone" | "iPad" | "iPod"
});
export type SimDeviceType = z.infer<typeof SimDeviceTypeSchema>;

export const SimRuntimeSchema = z.object({
  identifier: z.string(), // "com.apple.CoreSimulator.SimRuntime.iOS-17-4"
  name: z.string(), // "iOS 17.4"
  deviceTypes: z.array(SimDeviceTypeSchema),
});
export type SimRuntime = z.infer<typeof SimRuntimeSchema>;

export const SimCatalogRequestSchema = req("simulator/catalog", {});
export const SimCatalogResponseSchema = resp("simulator/catalog/response", {
  runtimes: z.array(SimRuntimeSchema),
});
export type SimCatalogPayload = z.infer<typeof SimCatalogResponseSchema>["payload"];

// ── create a new simulator (`simctl create`), optionally booting it headless ──
export const SimCreateRequestSchema = req("simulator/create", {
  name: z.string(),
  deviceTypeId: z.string(),
  runtimeId: z.string(),
  boot: z.boolean().optional(),
});
export const SimCreateResponseSchema = resp("simulator/create/response", {
  udid: z.string(),
});
export type SimCreatePayload = z.infer<typeof SimCreateResponseSchema>["payload"];

// ── HID input (idb) ──
// `coords` "device" (default): points on iOS, pixels on Android — the unit describe-ui reports.
// "ratio": 0..1 of the frame being viewed (spec 27.5); physical devices only.
export const SimCoordsSchema = z.enum(["device", "ratio"]);
export type SimCoords = z.infer<typeof SimCoordsSchema>;
export const SimTapRequestSchema = req("simulator/tap", {
  udid: z.string(),
  x: z.number(),
  y: z.number(),
  coords: SimCoordsSchema.optional(),
});
export const SimTapResponseSchema = resp("simulator/tap/response", {});
export type SimTapPayload = z.infer<typeof SimTapResponseSchema>["payload"];

export const SimSwipeRequestSchema = req("simulator/swipe", {
  udid: z.string(),
  x1: z.number(),
  y1: z.number(),
  x2: z.number(),
  y2: z.number(),
  durationMs: z.number().int().nonnegative().optional(),
  coords: SimCoordsSchema.optional(),
});
export const SimSwipeResponseSchema = resp("simulator/swipe/response", {});
export type SimSwipePayload = z.infer<typeof SimSwipeResponseSchema>["payload"];

export const SimInputTextRequestSchema = req("simulator/input-text", {
  udid: z.string(),
  text: z.string(),
});
export const SimInputTextResponseSchema = resp("simulator/input-text/response", {});
export type SimInputTextPayload = z.infer<typeof SimInputTextResponseSchema>["payload"];

export const SimButtonRequestSchema = req("simulator/button", {
  udid: z.string(),
  button: SimButtonSchema,
});
export const SimButtonResponseSchema = resp("simulator/button/response", {});
export type SimButtonPayload = z.infer<typeof SimButtonResponseSchema>["payload"];

// ── accessibility tree ──
export const SimDescribeUiRequestSchema = req("simulator/describe-ui", { udid: z.string() });
export const SimDescribeUiResponseSchema = resp("simulator/describe-ui/response", {
  elements: z.array(SimUiElementSchema),
});
export type SimDescribeUiPayload = z.infer<typeof SimDescribeUiResponseSchema>["payload"];

// ── screenshot (base64) ──
// A full-resolution PNG is 1–5 MB per frame (4.6 MB for an iPad); polling a fleet of them floods
// the socket until the liveness ping fails. Live views ask for `format: "jpeg"` (~15× smaller) and a
// `maxDim` long-edge cap sized to what they draw. Omitting both keeps the original full-res PNG, so
// older clients are unaffected. `pngBase64` is filled only for PNG frames (older clients read it);
// newer clients read `imageBase64` + `mimeType` + the frame's pixel `width`/`height`.
export const SimScreenshotFormatSchema = z.enum(["png", "jpeg"]);
export type SimScreenshotFormat = z.infer<typeof SimScreenshotFormatSchema>;
export const SimScreenshotRequestSchema = req("simulator/screenshot", {
  udid: z.string(),
  format: SimScreenshotFormatSchema.optional(),
  maxDim: z.number().int().positive().optional(),
});
export const SimScreenshotResponseSchema = resp("simulator/screenshot/response", {
  pngBase64: z.string(),
  imageBase64: z.string().optional(),
  mimeType: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});
export type SimScreenshotPayload = z.infer<typeof SimScreenshotResponseSchema>["payload"];

// ── apps ──
export const SimInstallAppRequestSchema = req("simulator/install-app", {
  udid: z.string(),
  appPath: z.string(),
});
export const SimInstallAppResponseSchema = resp("simulator/install-app/response", {});
export type SimInstallAppPayload = z.infer<typeof SimInstallAppResponseSchema>["payload"];

// Batch install a .app or .ipa onto many simulators at once. Per-simulator result so one failure
// (e.g. a device .ipa that a simulator cannot run) does not hide the successes.
export const SimInstallResultSchema = z.object({
  udid: z.string(),
  ok: z.boolean(),
  error: z.string().nullable(),
});
export const SimInstallBatchRequestSchema = req("simulator/install-batch", {
  udids: z.array(z.string()),
  filePath: z.string(),
});
export const SimInstallBatchResponseSchema = resp("simulator/install-batch/response", {
  results: z.array(SimInstallResultSchema),
});
export type SimInstallBatchPayload = z.infer<typeof SimInstallBatchResponseSchema>["payload"];

export const SimLaunchAppRequestSchema = req("simulator/launch-app", {
  udid: z.string(),
  bundleId: z.string(),
  terminateExisting: z.boolean().optional(),
});
export const SimLaunchAppResponseSchema = resp("simulator/launch-app/response", {});
export type SimLaunchAppPayload = z.infer<typeof SimLaunchAppResponseSchema>["payload"];

export const SimTerminateAppRequestSchema = req("simulator/terminate-app", {
  udid: z.string(),
  bundleId: z.string(),
});
export const SimTerminateAppResponseSchema = resp("simulator/terminate-app/response", {});
export type SimTerminateAppPayload = z.infer<typeof SimTerminateAppResponseSchema>["payload"];

// ── deep link ──
export const SimOpenUrlRequestSchema = req("simulator/open-url", {
  udid: z.string(),
  url: z.string(),
});
export const SimOpenUrlResponseSchema = resp("simulator/open-url/response", {});
export type SimOpenUrlPayload = z.infer<typeof SimOpenUrlResponseSchema>["payload"];

// ── density: slim / unslim ──
export const SimSlimRequestSchema = req("simulator/slim", {
  udid: z.string(),
  reboot: z.boolean().optional(),
});
export const SimSlimResponseSchema = resp("simulator/slim/response", {
  udid: z.string(),
  slimState: SimSlimStateSchema,
});
export type SimSlimPayload = z.infer<typeof SimSlimResponseSchema>["payload"];

export const SimUnslimRequestSchema = req("simulator/unslim", { udid: z.string() });
export const SimUnslimResponseSchema = resp("simulator/unslim/response", {
  udid: z.string(),
  slimState: SimSlimStateSchema,
});
export type SimUnslimPayload = z.infer<typeof SimUnslimResponseSchema>["payload"];

// ── live fleet snapshot subscription (polled sweep of `simctl list`) ──
export const SimSubscribeRequestSchema = req("simulator/subscribe", {
  subscriptionId: z.string(),
});
export const SimSubscribeResponseSchema = resp("simulator/subscribe/response", {
  subscriptionId: z.string(),
});
export const SimUnsubscribeRequestSchema = req("simulator/unsubscribe", {
  subscriptionId: z.string(),
});
export const SimUnsubscribeResponseSchema = resp("simulator/unsubscribe/response", {
  subscriptionId: z.string(),
});
export const SimSnapshotPushSchema = push("simulator/snapshot", {
  availability: SimAvailabilitySchema,
  devices: z.array(SimDeviceSchema),
});
export type SimSnapshotPayload = z.infer<typeof SimSnapshotPushSchema>["payload"];

// ── live logs subscription (`simctl spawn <udid> log stream`) ──
export const SimLogsSubscribeRequestSchema = req("simulator/logs/subscribe", {
  subscriptionId: z.string(),
  udid: z.string(),
});
export const SimLogsSubscribeResponseSchema = resp("simulator/logs/subscribe/response", {
  subscriptionId: z.string(),
});
export const SimLogsUnsubscribeRequestSchema = req("simulator/logs/unsubscribe", {
  subscriptionId: z.string(),
});
export const SimLogsUnsubscribeResponseSchema = resp("simulator/logs/unsubscribe/response", {
  subscriptionId: z.string(),
});
export const SimLogChunkPushSchema = push("simulator/log-chunk", {
  chunk: z.string(),
});
export type SimLogChunkPayload = z.infer<typeof SimLogChunkPushSchema>["payload"];

// ── physical devices (spec 27.3, 27.4, 27.7) ──
// Enable/disable control of one physical device. Off is the default; while off the daemon refuses
// every capture, log, UI-tree, input and install call with `control_disabled`.
export const SimPhysicalEnableRequestSchema = req("simulator/physical/enable", {
  udid: z.string(),
});
export const SimPhysicalEnableResponseSchema = resp("simulator/physical/enable/response", {
  udid: z.string(),
  controlEnabled: z.boolean(),
});
export type SimPhysicalEnablePayload = z.infer<typeof SimPhysicalEnableResponseSchema>["payload"];
export const SimPhysicalDisableRequestSchema = req("simulator/physical/disable", {
  udid: z.string(),
});
export const SimPhysicalDisableResponseSchema = resp("simulator/physical/disable/response", {
  udid: z.string(),
  controlEnabled: z.boolean(),
});
export type SimPhysicalDisablePayload = z.infer<typeof SimPhysicalDisableResponseSchema>["payload"];

// iOS touch setup ("Enable touch", spec 27.4): sign + install WebDriverAgent with an Apple account
// of spec 26. Without accountId: one saved account is used; several answer `account_required` +
// `accounts`; none answers `no_apple_account` (the app shows Add Apple ID in the same dialog).
// Touch RPCs on an iPhone without WDA answer `wda_required`; the app then runs this in place.
export const SimSignerAccountSchema = z.object({ id: z.string(), label: z.string() });
export type SimSignerAccount = z.infer<typeof SimSignerAccountSchema>;
export const SimPhysicalPrepareRequestSchema = req("simulator/physical/prepare", {
  udid: z.string(),
  accountId: z.string().optional(),
});
export const SimPhysicalPrepareResponseSchema = resp("simulator/physical/prepare/response", {
  udid: z.string(),
  accounts: z.array(SimSignerAccountSchema),
  bundleId: z.string().nullable(),
  expiresAt_ms: z.number().nullable(),
});
export type SimPhysicalPreparePayload = z.infer<typeof SimPhysicalPrepareResponseSchema>["payload"];
export const SimPhysicalPrepareStepSchema = z.enum([
  "download",
  "sign",
  "install",
  "launch",
  "done",
]);
export const SimPhysicalPrepareProgressPushSchema = z.object({
  type: z.literal("simulator/physical/prepare/progress"),
  payload: z.object({
    requestId: z.string(),
    udid: z.string(),
    step: SimPhysicalPrepareStepSchema,
    message: z.string(),
  }),
});
export type SimPhysicalPrepareProgressPayload = z.infer<
  typeof SimPhysicalPrepareProgressPushSchema
>["payload"];

// ── live screen (spec 27.5, ADR-0033) ──
// JPEG frames arrive as binary WebSocket frames (binary-frames/screen.ts) tagged with this
// subscriptionId. Only clients that advertise the `binary_screen_frames` capability subscribe;
// others keep polling simulator/screenshot. maxFps ≤ 15, maxDim ≤ 1280 (the daemon clamps).
// "screencap" is any polled capture: Android screencap, and an iPhone without WebDriverAgent
// (the device's screenshot service over the cable, spec 27.5).
export const SimScreenSourceSchema = z.enum(["scrcpy", "screencap", "wda-mjpeg"]);
export type SimScreenSource = z.infer<typeof SimScreenSourceSchema>;
export const SimScreenSubscribeRequestSchema = req("simulator/screen/subscribe", {
  subscriptionId: z.string(),
  udid: z.string(),
  maxFps: z.number().int().positive().optional(),
  maxDim: z.number().int().positive().optional(),
});
export const SimScreenSubscribeResponseSchema = resp("simulator/screen/subscribe/response", {
  subscriptionId: z.string(),
  source: SimScreenSourceSchema.nullable(),
});
export type SimScreenSubscribePayload = z.infer<typeof SimScreenSubscribeResponseSchema>["payload"];
export const SimScreenUnsubscribeRequestSchema = req("simulator/screen/unsubscribe", {
  subscriptionId: z.string(),
});
export const SimScreenUnsubscribeResponseSchema = resp("simulator/screen/unsubscribe/response", {
  subscriptionId: z.string(),
});

export const SimulatorRequestSchemas = [
  SimListRequestSchema,
  SimActionRequestSchema,
  SimCatalogRequestSchema,
  SimCreateRequestSchema,
  SimTapRequestSchema,
  SimSwipeRequestSchema,
  SimInputTextRequestSchema,
  SimButtonRequestSchema,
  SimDescribeUiRequestSchema,
  SimScreenshotRequestSchema,
  SimInstallAppRequestSchema,
  SimInstallBatchRequestSchema,
  SimLaunchAppRequestSchema,
  SimTerminateAppRequestSchema,
  SimOpenUrlRequestSchema,
  SimSlimRequestSchema,
  SimUnslimRequestSchema,
  SimSubscribeRequestSchema,
  SimUnsubscribeRequestSchema,
  SimLogsSubscribeRequestSchema,
  SimLogsUnsubscribeRequestSchema,
  SimPhysicalEnableRequestSchema,
  SimPhysicalDisableRequestSchema,
  SimPhysicalPrepareRequestSchema,
  SimScreenSubscribeRequestSchema,
  SimScreenUnsubscribeRequestSchema,
] as const;

export const SimulatorResponseSchemas = [
  SimListResponseSchema,
  SimActionResponseSchema,
  SimCatalogResponseSchema,
  SimCreateResponseSchema,
  SimTapResponseSchema,
  SimSwipeResponseSchema,
  SimInputTextResponseSchema,
  SimButtonResponseSchema,
  SimDescribeUiResponseSchema,
  SimScreenshotResponseSchema,
  SimInstallAppResponseSchema,
  SimInstallBatchResponseSchema,
  SimLaunchAppResponseSchema,
  SimTerminateAppResponseSchema,
  SimOpenUrlResponseSchema,
  SimSlimResponseSchema,
  SimUnslimResponseSchema,
  SimSubscribeResponseSchema,
  SimUnsubscribeResponseSchema,
  SimLogsSubscribeResponseSchema,
  SimLogsUnsubscribeResponseSchema,
  SimPhysicalEnableResponseSchema,
  SimPhysicalDisableResponseSchema,
  SimPhysicalPrepareResponseSchema,
  SimScreenSubscribeResponseSchema,
  SimScreenUnsubscribeResponseSchema,
] as const;

export const SimulatorPushSchemas = [
  SimSnapshotPushSchema,
  SimLogChunkPushSchema,
  SimPhysicalPrepareProgressPushSchema,
] as const;
