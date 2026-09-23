import { z } from "zod";

// Wire schemas for the Docker cockpit. Mirrors database/rpc-schemas.ts: every request
// carries a `type` literal + `requestId`; every response is
// `{ type, payload: { requestId, ...data, error } }`. Backed by the host docker CLI.

export const DockerContainerSchema = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string(),
  status: z.string(),
  state: z.string(),
  ports: z.string(),
  createdAt: z.string(),
  // Compose grouping, parsed from the com.docker.compose.* labels. Empty when the
  // container is not part of a Compose project (standalone `docker run`).
  project: z.string(),
  service: z.string(),
});
export type DockerContainer = z.infer<typeof DockerContainerSchema>;

export const DockerImageSchema = z.object({
  id: z.string(),
  repository: z.string(),
  tag: z.string(),
  size: z.string(),
  createdSince: z.string(),
});
export type DockerImage = z.infer<typeof DockerImageSchema>;

export const DockerVolumeSchema = z.object({
  name: z.string(),
  driver: z.string(),
  scope: z.string(),
});
export type DockerVolume = z.infer<typeof DockerVolumeSchema>;

export const DockerStatsSchema = z.object({
  cpuPerc: z.string(),
  memUsage: z.string(),
  memPerc: z.string(),
  netIO: z.string(),
  blockIO: z.string(),
  pids: z.string(),
});
export type DockerStats = z.infer<typeof DockerStatsSchema>;

export const DockerActionSchema = z.enum([
  "start",
  "stop",
  "restart",
  "pause",
  "unpause",
  "remove",
]);
export type DockerAction = z.infer<typeof DockerActionSchema>;

export const DockerImageActionSchema = z.enum(["remove", "pull", "run"]);
export type DockerImageAction = z.infer<typeof DockerImageActionSchema>;

export const DockerVolumeActionSchema = z.enum(["remove", "prune"]);
export type DockerVolumeAction = z.infer<typeof DockerVolumeActionSchema>;

function req<T extends string, S extends z.ZodRawShape>(type: T, extra: S) {
  return z.object({ type: z.literal(type), requestId: z.string(), ...extra });
}
function resp<T extends string, S extends z.ZodRawShape>(type: T, extra: S) {
  return z.object({
    type: z.literal(type),
    payload: z.object({ requestId: z.string(), error: z.string().nullable(), ...extra }),
  });
}

// ── list (containers + images) ──
export const DockerListRequestSchema = req("docker/list", {});
export const DockerListResponseSchema = resp("docker/list/response", {
  available: z.boolean(),
  containers: z.array(DockerContainerSchema),
  images: z.array(DockerImageSchema),
});
export type DockerListPayload = z.infer<typeof DockerListResponseSchema>["payload"];

// ── logs ──
export const DockerLogsRequestSchema = req("docker/logs", {
  container: z.string(),
  tail: z.number().int().positive().optional(),
});
export const DockerLogsResponseSchema = resp("docker/logs/response", {
  logs: z.string(),
});
export type DockerLogsPayload = z.infer<typeof DockerLogsResponseSchema>["payload"];

// ── inspect (docker inspect, pretty JSON) ──
export const DockerInspectRequestSchema = req("docker/inspect", {
  container: z.string(),
});
export const DockerInspectResponseSchema = resp("docker/inspect/response", {
  inspect: z.string(),
});
export type DockerInspectPayload = z.infer<typeof DockerInspectResponseSchema>["payload"];

// ── action (start/stop/restart/remove) ──
export const DockerActionRequestSchema = req("docker/action", {
  container: z.string(),
  action: DockerActionSchema,
});
export const DockerActionResponseSchema = resp("docker/action/response", {});
export type DockerActionPayload = z.infer<typeof DockerActionResponseSchema>["payload"];

// Unsolicited server→client push, keyed by subscriptionId (no requestId).
function push<T extends string, S extends z.ZodRawShape>(type: T, extra: S) {
  return z.object({
    type: z.literal(type),
    payload: z.object({ subscriptionId: z.string(), ...extra }),
  });
}

// ── live snapshot subscription (docker events → fresh containers/images/volumes) ──
export const DockerSubscribeRequestSchema = req("docker/subscribe", {
  subscriptionId: z.string(),
});
export const DockerSubscribeResponseSchema = resp("docker/subscribe/response", {
  subscriptionId: z.string(),
});
export const DockerUnsubscribeRequestSchema = req("docker/unsubscribe", {
  subscriptionId: z.string(),
});
export const DockerUnsubscribeResponseSchema = resp("docker/unsubscribe/response", {
  subscriptionId: z.string(),
});
export const DockerSnapshotPushSchema = push("docker/snapshot", {
  available: z.boolean(),
  containers: z.array(DockerContainerSchema),
  images: z.array(DockerImageSchema),
  volumes: z.array(DockerVolumeSchema),
});
export type DockerSnapshotPayload = z.infer<typeof DockerSnapshotPushSchema>["payload"];

// ── live logs subscription (docker logs -f) ──
export const DockerLogsSubscribeRequestSchema = req("docker/logs/subscribe", {
  subscriptionId: z.string(),
  container: z.string(),
  tail: z.number().int().positive().optional(),
});
export const DockerLogsSubscribeResponseSchema = resp("docker/logs/subscribe/response", {
  subscriptionId: z.string(),
});
export const DockerLogsUnsubscribeRequestSchema = req("docker/logs/unsubscribe", {
  subscriptionId: z.string(),
});
export const DockerLogsUnsubscribeResponseSchema = resp("docker/logs/unsubscribe/response", {
  subscriptionId: z.string(),
});
export const DockerLogChunkPushSchema = push("docker/log-chunk", {
  chunk: z.string(),
});
export type DockerLogChunkPayload = z.infer<typeof DockerLogChunkPushSchema>["payload"];

// ── live stats subscription (docker stats) ──
export const DockerStatsSubscribeRequestSchema = req("docker/stats/subscribe", {
  subscriptionId: z.string(),
  container: z.string(),
});
export const DockerStatsSubscribeResponseSchema = resp("docker/stats/subscribe/response", {
  subscriptionId: z.string(),
});
export const DockerStatsUnsubscribeRequestSchema = req("docker/stats/unsubscribe", {
  subscriptionId: z.string(),
});
export const DockerStatsUnsubscribeResponseSchema = resp("docker/stats/unsubscribe/response", {
  subscriptionId: z.string(),
});
export const DockerStatsPushSchema = push("docker/stats-data", {
  stats: DockerStatsSchema,
});
export type DockerStatsPayload = z.infer<typeof DockerStatsPushSchema>["payload"];

// ── exec a one-shot command inside a container ──
export const DockerExecRequestSchema = req("docker/exec", {
  container: z.string(),
  command: z.string(),
});
export const DockerExecResponseSchema = resp("docker/exec/response", {
  output: z.string(),
});
export type DockerExecPayload = z.infer<typeof DockerExecResponseSchema>["payload"];

// ── image action (remove/pull/run) ──
export const DockerImageActionRequestSchema = req("docker/image/action", {
  image: z.string(),
  action: DockerImageActionSchema,
});
export const DockerImageActionResponseSchema = resp("docker/image/action/response", {});
export type DockerImageActionPayload = z.infer<typeof DockerImageActionResponseSchema>["payload"];

// ── volume action (remove/prune) ──
export const DockerVolumeActionRequestSchema = req("docker/volume/action", {
  name: z.string(),
  action: DockerVolumeActionSchema,
});
export const DockerVolumeActionResponseSchema = resp("docker/volume/action/response", {});
export type DockerVolumeActionPayload = z.infer<typeof DockerVolumeActionResponseSchema>["payload"];

export const DockerRequestSchemas = [
  DockerListRequestSchema,
  DockerLogsRequestSchema,
  DockerInspectRequestSchema,
  DockerActionRequestSchema,
  DockerSubscribeRequestSchema,
  DockerUnsubscribeRequestSchema,
  DockerLogsSubscribeRequestSchema,
  DockerLogsUnsubscribeRequestSchema,
  DockerStatsSubscribeRequestSchema,
  DockerStatsUnsubscribeRequestSchema,
  DockerExecRequestSchema,
  DockerImageActionRequestSchema,
  DockerVolumeActionRequestSchema,
] as const;

export const DockerResponseSchemas = [
  DockerListResponseSchema,
  DockerLogsResponseSchema,
  DockerInspectResponseSchema,
  DockerActionResponseSchema,
  DockerSubscribeResponseSchema,
  DockerUnsubscribeResponseSchema,
  DockerLogsSubscribeResponseSchema,
  DockerLogsUnsubscribeResponseSchema,
  DockerStatsSubscribeResponseSchema,
  DockerStatsUnsubscribeResponseSchema,
  DockerExecResponseSchema,
  DockerImageActionResponseSchema,
  DockerVolumeActionResponseSchema,
] as const;

// Unsolicited server→client pushes (subscription streams).
export const DockerPushSchemas = [
  DockerSnapshotPushSchema,
  DockerLogChunkPushSchema,
  DockerStatsPushSchema,
] as const;
