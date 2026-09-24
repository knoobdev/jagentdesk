import { z } from "zod";

// Wire schemas for SimFleet — the iOS-Simulator control plane. One control surface shared by
// the human UI and the agent tools: list/boot/shutdown, HID input (tap/swipe/type/buttons),
// accessibility-tree inspection, screenshots, app install/launch, deep links, and a density
// "slim" engine (disable background daemons so many simulators fit on one Mac). Mirrors
// docker/rpc-schemas.ts: every request carries a `type` literal + `requestId`; every response is
// `{ type, payload: { requestId, ...data, error } }`. Backed by the host `xcrun simctl` + `idb`.
// macOS-only; the daemon reports availability rather than erroring on other platforms.

// What the daemon can actually do, probed at request time. `idb` unlocks HID input + the
// accessibility tree; without it the daemon runs in simctl-only mode (lifecycle + screenshot +
// logs + open-url still work). `xcode` is false when only the Command Line Tools are selected.
export const SimAvailabilitySchema = z.object({
  simctl: z.boolean(),
  idb: z.boolean(),
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

// ── screenshot (PNG, base64) ──
export const SimScreenshotRequestSchema = req("simulator/screenshot", { udid: z.string() });
export const SimScreenshotResponseSchema = resp("simulator/screenshot/response", {
  pngBase64: z.string(),
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
