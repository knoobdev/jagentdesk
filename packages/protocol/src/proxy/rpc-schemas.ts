import { z } from "zod";

// Wire schemas for the Workbench — an intercepting-HTTP-proxy security-testing workbench (a Burp
// Suite CE-style toolset) that captures traffic from the host's own iOS Simulators (SimFleet) for
// authorized app-security testing. One control surface shared by the human UI and the agent tools.
// Mirrors simulator/rpc-schemas.ts: every request carries a `type` literal + `requestId`; every
// response is `{ type, payload: { requestId, ...data, error } }`; every push is
// `{ type, payload: { subscriptionId, ... } }`. The MITM engine is built on node core + node-forge
// (no native deps). P1 covers capture lifecycle + HTTP history + a transaction stream; Frida
// unpinning and per-simulator attribution arrive in a later phase.

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

// How a capture session steers traffic into the listener.
//  - manual: user points a client at the listener (host:port) themselves (P1 default).
//  - system: the daemon sets the Mac system HTTP/HTTPS proxy to the listener (all traffic).
//  - frida: Frida injects the target app on a simulator and forces it through this listener,
//    which is also what attributes traffic to a single udid+bundleId (P4).
export const ProxyCaptureModeSchema = z.enum(["manual", "system", "frida"]);
export type ProxyCaptureMode = z.infer<typeof ProxyCaptureModeSchema>;

export const ProxySessionStateSchema = z.enum(["starting", "running", "stopped", "error"]);
export type ProxySessionState = z.infer<typeof ProxySessionStateSchema>;

export const ProxyCaptureSessionSchema = z.object({
  id: z.string(),
  label: z.string(),
  mode: ProxyCaptureModeSchema,
  state: ProxySessionStateSchema,
  listenerHost: z.string(), // "127.0.0.1"
  listenerPort: z.number(),
  udid: z.string().nullable(), // set when bound to a specific simulator (frida mode)
  bundleId: z.string().nullable(),
  startedAt_ms: z.number(),
  stoppedAt_ms: z.number().nullable(),
  transactionCount: z.number(),
  error: z.string().nullable(),
});
export type ProxyCaptureSession = z.infer<typeof ProxyCaptureSessionSchema>;

// One header, order-preserving (a Map loses duplicates; security testing needs raw order).
export const ProxyHeaderSchema = z.object({ name: z.string(), value: z.string() });
export type ProxyHeader = z.infer<typeof ProxyHeaderSchema>;

// A row in the HTTP history table — metadata only, no bodies (kept light for the live stream and
// large tables). The Burp HTTP-history columns map onto these fields.
export const ProxyTransactionRowSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  seq: z.number(), // the "#" column, monotonic per session
  ts_ms: z.number(),
  secure: z.boolean(), // https vs http (the "TLS" column)
  host: z.string(),
  port: z.number(),
  method: z.string(),
  url: z.string(), // path + query as shown in Burp's URL column
  paramCount: z.number(),
  status: z.number().nullable(), // null while in flight / on error
  responseLength: z.number().nullable(),
  mimeType: z.string(),
  extension: z.string(),
  title: z.string(), // parsed <title> for html responses
  clientIp: z.string(),
  clientPort: z.number(),
  udid: z.string().nullable(),
  bundleId: z.string().nullable(),
  durationMs: z.number().nullable(),
  edited: z.boolean(),
  comment: z.string(),
  highlight: z.string().nullable(), // user color tag
});
export type ProxyTransactionRow = z.infer<typeof ProxyTransactionRowSchema>;

// The full message pair for the message editor / transactionGet. Bodies are base64 so binary
// survives the wire; `*BodyIsText` tells the client whether to show text or hex by default.
export const ProxyTransactionFullSchema = ProxyTransactionRowSchema.extend({
  requestLine: z.string(), // "GET /path?q=1 HTTP/1.1"
  requestHeaders: z.array(ProxyHeaderSchema),
  requestBodyB64: z.string(),
  requestBodyIsText: z.boolean(),
  statusLine: z.string(),
  responseHeaders: z.array(ProxyHeaderSchema),
  responseBodyB64: z.string(),
  responseBodyIsText: z.boolean(),
});
export type ProxyTransactionFull = z.infer<typeof ProxyTransactionFullSchema>;

// ── capture start ──
export const ProxyCaptureStartRequestSchema = req("proxy/capture/start", {
  mode: ProxyCaptureModeSchema,
  label: z.string().optional(),
  udid: z.string().optional(),
  bundleId: z.string().optional(),
});
export const ProxyCaptureStartResponseSchema = resp("proxy/capture/start/response", {
  session: ProxyCaptureSessionSchema.nullable(),
});

// ── capture stop ──
export const ProxyCaptureStopRequestSchema = req("proxy/capture/stop", {
  sessionId: z.string(),
});
export const ProxyCaptureStopResponseSchema = resp("proxy/capture/stop/response", {
  sessionId: z.string(),
});

// ── session remove (delete a capture session + its history) ──
export const ProxySessionRemoveRequestSchema = req("proxy/session/remove", {
  sessionId: z.string(),
});
export const ProxySessionRemoveResponseSchema = resp("proxy/session/remove/response", {
  sessionId: z.string(),
});

// ── sessions list ──
export const ProxySessionsListRequestSchema = req("proxy/sessions/list", {});
export const ProxySessionsListResponseSchema = resp("proxy/sessions/list/response", {
  sessions: z.array(ProxyCaptureSessionSchema),
});

// ── history query ──
export const ProxyHistoryQueryRequestSchema = req("proxy/history/query", {
  sessionId: z.string().nullable(),
  host: z.string().optional(),
  method: z.string().optional(),
  status: z.number().optional(),
  contains: z.string().optional(),
  inScopeOnly: z.boolean().optional(),
  limit: z.number().optional(),
});
export const ProxyHistoryQueryResponseSchema = resp("proxy/history/query/response", {
  rows: z.array(ProxyTransactionRowSchema),
});

// ── transaction get (full request/response) ──
export const ProxyTransactionGetRequestSchema = req("proxy/transaction/get", {
  id: z.string(),
});
export const ProxyTransactionGetResponseSchema = resp("proxy/transaction/get/response", {
  transaction: ProxyTransactionFullSchema.nullable(),
});

// ── history management (Burp: Clear history / Delete item / Highlight + Add comment) ──
export const ProxyHistoryClearRequestSchema = req("proxy/history/clear", {
  sessionId: z.string().nullable(),
});
export const ProxyHistoryClearResponseSchema = resp("proxy/history/clear/response", {});

export const ProxyTransactionDeleteRequestSchema = req("proxy/transaction/delete", {
  id: z.string(),
});
export const ProxyTransactionDeleteResponseSchema = resp("proxy/transaction/delete/response", {
  id: z.string(),
});

export const ProxyTransactionAnnotateRequestSchema = req("proxy/transaction/annotate", {
  id: z.string(),
  comment: z.string().optional(),
  highlight: z.string().nullable().optional(),
});
export const ProxyTransactionAnnotateResponseSchema = resp("proxy/transaction/annotate/response", {
  row: ProxyTransactionRowSchema.nullable(),
});
export type ProxyTransactionAnnotatePayload = z.infer<
  typeof ProxyTransactionAnnotateResponseSchema
>["payload"];

// ── CA certificate export (to trust in a simulator / client) ──
export const ProxyCaExportRequestSchema = req("proxy/ca/export", {});
export const ProxyCaExportResponseSchema = resp("proxy/ca/export/response", {
  pem: z.string(),
});

// ── subscribe / unsubscribe (live transaction + session stream) ──
export const ProxySubscribeRequestSchema = req("proxy/subscribe", {
  subscriptionId: z.string(),
});
export const ProxySubscribeResponseSchema = resp("proxy/subscribe/response", {
  subscriptionId: z.string(),
});
export const ProxyUnsubscribeRequestSchema = req("proxy/unsubscribe", {
  subscriptionId: z.string(),
});
export const ProxyUnsubscribeResponseSchema = resp("proxy/unsubscribe/response", {
  subscriptionId: z.string(),
});

// ── repeater send (replay an arbitrary request, Burp Repeater) ──
export const ProxyRepeaterSendRequestSchema = req("proxy/repeater/send", {
  secure: z.boolean(),
  host: z.string(),
  port: z.number(),
  method: z.string(),
  path: z.string(),
  headers: z.array(ProxyHeaderSchema),
  bodyB64: z.string(),
});
export const ProxyRepeaterSendResponseSchema = resp("proxy/repeater/send/response", {
  transaction: ProxyTransactionFullSchema.nullable(),
});
export type ProxyRepeaterSendPayload = z.infer<typeof ProxyRepeaterSendResponseSchema>["payload"];

// ── intruder run (Burp Intruder; Community Edition = Sniper + throttled/limited) ──
export const ProxyIntruderResultSchema = z.object({
  index: z.number(),
  payload: z.string(),
  status: z.number().nullable(),
  length: z.number(),
  durationMs: z.number(),
  error: z.string().nullable(),
});
export type ProxyIntruderResult = z.infer<typeof ProxyIntruderResultSchema>;

export const ProxyIntruderRunRequestSchema = req("proxy/intruder/run", {
  secure: z.boolean(),
  host: z.string(),
  port: z.number(),
  template: z.string(), // raw request with §payload§ markers
  payloads: z.array(z.string()),
});
export const ProxyIntruderRunResponseSchema = resp("proxy/intruder/run/response", {
  results: z.array(ProxyIntruderResultSchema),
  throttled: z.boolean(), // Community Edition applies a per-request delay
  truncated: z.boolean(), // capped payload count (CE limit)
});
export type ProxyIntruderRunPayload = z.infer<typeof ProxyIntruderRunResponseSchema>["payload"];

// ── frida availability + guided install (for TLS unpinning) ──
export const ProxyFridaStatusRequestSchema = req("proxy/frida/status", {});
export const ProxyFridaStatusResponseSchema = resp("proxy/frida/status/response", {
  frida: z.boolean(),
  version: z.string().nullable(),
  installer: z.enum(["pipx", "pip3", "pip"]).nullable(),
});
export type ProxyFridaStatusPayload = z.infer<typeof ProxyFridaStatusResponseSchema>["payload"];

export const ProxyFridaInstallRequestSchema = req("proxy/frida/install", {});
export const ProxyFridaInstallResponseSchema = resp("proxy/frida/install/response", {
  ok: z.boolean(),
  log: z.string(),
  frida: z.boolean(),
});
export type ProxyFridaInstallPayload = z.infer<typeof ProxyFridaInstallResponseSchema>["payload"];

// ── scope (Burp Target scope: include/exclude rules) ──
export const ProxyScopeRuleSchema = z.object({
  enabled: z.boolean(),
  include: z.boolean(), // true = include-in-scope, false = exclude
  protocol: z.enum(["http", "https", "any"]),
  host: z.string(), // substring or regex (see useRegex)
  port: z.string(), // "" = any
  useRegex: z.boolean(),
});
export type ProxyScopeRule = z.infer<typeof ProxyScopeRuleSchema>;

export const ProxyScopeGetRequestSchema = req("proxy/scope/get", {});
export const ProxyScopeGetResponseSchema = resp("proxy/scope/get/response", {
  rules: z.array(ProxyScopeRuleSchema),
});
export type ProxyScopeGetPayload = z.infer<typeof ProxyScopeGetResponseSchema>["payload"];

export const ProxyScopeSetRequestSchema = req("proxy/scope/set", {
  rules: z.array(ProxyScopeRuleSchema),
});
export const ProxyScopeSetResponseSchema = resp("proxy/scope/set/response", {
  rules: z.array(ProxyScopeRuleSchema),
});

// ── intercept (Burp Proxy › Intercept: hold a request, edit, forward or drop) ──
export const ProxyHeldRequestSchema = z.object({
  heldId: z.string(),
  sessionId: z.string(),
  secure: z.boolean(),
  host: z.string(),
  port: z.number(),
  method: z.string(),
  path: z.string(),
  headers: z.array(ProxyHeaderSchema),
  bodyB64: z.string(),
  udid: z.string().nullable(),
  bundleId: z.string().nullable(),
});
export type ProxyHeldRequest = z.infer<typeof ProxyHeldRequestSchema>;

export const ProxyInterceptSetRequestSchema = req("proxy/intercept/set", {
  enabled: z.boolean(),
});
export const ProxyInterceptSetResponseSchema = resp("proxy/intercept/set/response", {
  enabled: z.boolean(),
});
export type ProxyInterceptSetPayload = z.infer<typeof ProxyInterceptSetResponseSchema>["payload"];

export const ProxyInterceptDecideRequestSchema = req("proxy/intercept/decide", {
  heldId: z.string(),
  action: z.enum(["forward", "drop"]),
  // present when the tester edited the held request before forwarding
  method: z.string().optional(),
  path: z.string().optional(),
  headers: z.array(ProxyHeaderSchema).optional(),
  bodyB64: z.string().optional(),
});
export const ProxyInterceptDecideResponseSchema = resp("proxy/intercept/decide/response", {
  heldId: z.string(),
});

// ── WebSockets history (Burp Proxy › WebSockets history) ──
export const ProxyWsMessageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  ts_ms: z.number(),
  host: z.string(),
  direction: z.enum(["to-server", "to-client"]),
  opcode: z.number(), // 1 = text, 2 = binary
  length: z.number(),
  preview: z.string(), // text preview (utf-8, truncated)
});
export type ProxyWsMessage = z.infer<typeof ProxyWsMessageSchema>;

// ── pushes ──
export const ProxyWsMessagePushSchema = push("proxy/ws-message", {
  message: ProxyWsMessageSchema,
});
export type ProxyWsMessagePushPayload = z.infer<typeof ProxyWsMessagePushSchema>["payload"];

export const ProxyInterceptHeldPushSchema = push("proxy/intercept/held", {
  held: ProxyHeldRequestSchema,
});
export type ProxyInterceptHeldPushPayload = z.infer<typeof ProxyInterceptHeldPushSchema>["payload"];

export const ProxyTransactionPushSchema = push("proxy/transaction", {
  row: ProxyTransactionRowSchema,
});
export type ProxyTransactionPushPayload = z.infer<typeof ProxyTransactionPushSchema>["payload"];

export const ProxySessionPushSchema = push("proxy/session", {
  session: ProxyCaptureSessionSchema,
});
export type ProxySessionPushPayload = z.infer<typeof ProxySessionPushSchema>["payload"];

export type ProxyCaptureStartPayload = z.infer<typeof ProxyCaptureStartResponseSchema>["payload"];
export type ProxyCaptureStopPayload = z.infer<typeof ProxyCaptureStopResponseSchema>["payload"];
export type ProxySessionsListPayload = z.infer<typeof ProxySessionsListResponseSchema>["payload"];
export type ProxyHistoryQueryPayload = z.infer<typeof ProxyHistoryQueryResponseSchema>["payload"];
export type ProxyTransactionGetPayload = z.infer<
  typeof ProxyTransactionGetResponseSchema
>["payload"];
export type ProxyCaExportPayload = z.infer<typeof ProxyCaExportResponseSchema>["payload"];

export const ProxyRequestSchemas = [
  ProxyCaptureStartRequestSchema,
  ProxyCaptureStopRequestSchema,
  ProxySessionsListRequestSchema,
  ProxySessionRemoveRequestSchema,
  ProxyHistoryQueryRequestSchema,
  ProxyTransactionGetRequestSchema,
  ProxyHistoryClearRequestSchema,
  ProxyTransactionDeleteRequestSchema,
  ProxyTransactionAnnotateRequestSchema,
  ProxyCaExportRequestSchema,
  ProxySubscribeRequestSchema,
  ProxyUnsubscribeRequestSchema,
  ProxyRepeaterSendRequestSchema,
  ProxyIntruderRunRequestSchema,
  ProxyInterceptSetRequestSchema,
  ProxyInterceptDecideRequestSchema,
  ProxyScopeGetRequestSchema,
  ProxyScopeSetRequestSchema,
  ProxyFridaStatusRequestSchema,
  ProxyFridaInstallRequestSchema,
] as const;

export const ProxyResponseSchemas = [
  ProxyCaptureStartResponseSchema,
  ProxyCaptureStopResponseSchema,
  ProxySessionsListResponseSchema,
  ProxySessionRemoveResponseSchema,
  ProxyHistoryQueryResponseSchema,
  ProxyTransactionGetResponseSchema,
  ProxyHistoryClearResponseSchema,
  ProxyTransactionDeleteResponseSchema,
  ProxyTransactionAnnotateResponseSchema,
  ProxyCaExportResponseSchema,
  ProxySubscribeResponseSchema,
  ProxyUnsubscribeResponseSchema,
  ProxyRepeaterSendResponseSchema,
  ProxyIntruderRunResponseSchema,
  ProxyInterceptSetResponseSchema,
  ProxyInterceptDecideResponseSchema,
  ProxyScopeGetResponseSchema,
  ProxyScopeSetResponseSchema,
  ProxyFridaStatusResponseSchema,
  ProxyFridaInstallResponseSchema,
] as const;

export const ProxyPushSchemas = [
  ProxyTransactionPushSchema,
  ProxySessionPushSchema,
  ProxyInterceptHeldPushSchema,
  ProxyWsMessagePushSchema,
] as const;
