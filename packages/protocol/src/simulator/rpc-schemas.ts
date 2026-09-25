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
});
export type SimAvailability = z.infer<typeof SimAvailabilitySchema>;

// "slim" = simslim-style density state, computed from the count of disabled background daemons.
// stock = untouched; slim = fully slimmed; partial = some disabled; unknown = not yet read.
export const SimSlimStateSchema = z.enum(["stock", "partial", "slim", "unknown"]);
export type SimSlimState = z.infer<typeof SimSlimStateSchema>;

export const SimDeviceSchema = z.object({
  udid: z.string(),
  name: z.string(),
  state: z.string(), // raw simctl state ("Booted" / "Shutdown" / "Creating" …)
  isBooted: z.boolean(),
  runtime: z.string(), // "iOS 18.5"
  deviceType: z.string(), // "iPhone 15 Pro"
  slimState: SimSlimStateSchema,
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

export const SimButtonSchema = z.enum(["home", "lock", "side-button", "siri", "apple-pay"]);
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
export const SimTapRequestSchema = req("simulator/tap", {
  udid: z.string(),
  x: z.number(),
  y: z.number(),
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
  SimLaunchAppRequestSchema,
  SimTerminateAppRequestSchema,
  SimOpenUrlRequestSchema,
  SimSlimRequestSchema,
  SimUnslimRequestSchema,
  SimSubscribeRequestSchema,
  SimUnsubscribeRequestSchema,
  SimLogsSubscribeRequestSchema,
  SimLogsUnsubscribeRequestSchema,
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
  SimLaunchAppResponseSchema,
  SimTerminateAppResponseSchema,
  SimOpenUrlResponseSchema,
  SimSlimResponseSchema,
  SimUnslimResponseSchema,
  SimSubscribeResponseSchema,
  SimUnsubscribeResponseSchema,
  SimLogsSubscribeResponseSchema,
  SimLogsUnsubscribeResponseSchema,
] as const;

export const SimulatorPushSchemas = [SimSnapshotPushSchema, SimLogChunkPushSchema] as const;
