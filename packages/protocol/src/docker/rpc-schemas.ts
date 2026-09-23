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

export const DockerActionSchema = z.enum(["start", "stop", "restart", "remove"]);
export type DockerAction = z.infer<typeof DockerActionSchema>;

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

// ── action (start/stop/restart/remove) ──
export const DockerActionRequestSchema = req("docker/action", {
  container: z.string(),
  action: DockerActionSchema,
});
export const DockerActionResponseSchema = resp("docker/action/response", {});
export type DockerActionPayload = z.infer<typeof DockerActionResponseSchema>["payload"];

export const DockerRequestSchemas = [
  DockerListRequestSchema,
  DockerLogsRequestSchema,
  DockerActionRequestSchema,
] as const;

export const DockerResponseSchemas = [
  DockerListResponseSchema,
  DockerLogsResponseSchema,
  DockerActionResponseSchema,
] as const;
