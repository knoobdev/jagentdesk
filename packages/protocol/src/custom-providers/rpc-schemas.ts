import { z } from "zod";

// Wire schemas for daemon-managed custom API providers (spec 34 / ADR-0047): an OpenAI- or
// Anthropic-compatible endpoint the user (Settings) or a chat agent (provider_* tools) adds,
// edits or removes without restarting the daemon. Envelope follows remote-exec/rpc-schemas.ts
// and docs/rpc-namespacing.md: requests carry `type` + `requestId`; responses are
// `{ type, payload: { requestId, error, ...data } }` with `error` as the "<code>: <message>"
// string convention (CustomProviderError codes, else "internal").
//
// The API key never reaches the wire in either direction's payloads: `apiKey` is request-only
// (save/test), and records/results carry `hasApiKey` only. Hand-written env-based custom
// providers from config.json are listed read-only as `EnvProviderSummary`.

function req<T extends string, S extends z.ZodRawShape>(type: T, extra: S) {
  return z.object({ type: z.literal(type), requestId: z.string(), ...extra });
}
function resp<T extends string, S extends z.ZodRawShape>(type: T, extra: S) {
  return z.object({
    type: z.literal(type),
    payload: z.object({ requestId: z.string(), error: z.string().nullable(), ...extra }),
  });
}

// ── DTO schemas ─────────────────────────────────────────────────────────

export const ApiProtocolSchema = z.enum(["openai", "anthropic"]);
export type ApiProtocol = z.infer<typeof ApiProtocolSchema>;

export const ApiRouteSchema = z.enum(["direct", "tailnet", "ssh"]);
export type ApiRoute = z.infer<typeof ApiRouteSchema>;

export const ApiProviderThinkingOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  isDefault: z.boolean().optional(),
});
export type ApiProviderThinkingOption = z.infer<typeof ApiProviderThinkingOptionSchema>;

export const ApiProviderModelSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  isDefault: z.boolean().optional(),
  contextWindow: z.number().int().positive().optional(),
  thinkingOptions: z.array(ApiProviderThinkingOptionSchema).optional(),
});
export type ApiProviderModel = z.infer<typeof ApiProviderModelSchema>;

/** A daemon-managed custom API provider (spec 34.2). Never carries the API key. */
export const ApiProviderRecordSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  protocol: ApiProtocolSchema,
  baseUrl: z.string().min(1),
  via: ApiRouteSchema,
  // Required on the record when via is "ssh": the SSH server (spec 25) to tunnel through.
  sshServerId: z.string().optional(),
  hasApiKey: z.boolean(),
  models: z.array(ApiProviderModelSchema),
  enabled: z.boolean(),
  order: z.number().int().optional(),
});
export type ApiProviderRecord = z.infer<typeof ApiProviderRecordSchema>;

/** A hand-written env-based custom provider from config.json: read-only in UI/tools. */
export const EnvProviderSummarySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  extends: z.string().min(1),
});
export type EnvProviderSummary = z.infer<typeof EnvProviderSummarySchema>;

export const ProviderTestResultSchema = z.object({
  ok: z.boolean(),
  models: z.array(z.object({ id: z.string() })),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type ProviderTestResult = z.infer<typeof ProviderTestResultSchema>;

// ── RPCs ────────────────────────────────────────────────────────────────

// All four need the `daemon.manage` permission (operation-permissions.ts), like the other
// daemon-config mutations.

export const CustomProvidersListRequestSchema = req("providers.custom.list.request", {});
export const CustomProvidersListResponseSchema = resp("providers.custom.list.response", {
  providers: z.array(ApiProviderRecordSchema),
  envProviders: z.array(EnvProviderSummarySchema),
});

// `mode` is on the wire beyond spec 34.7's `{ provider, apiKey? }` payload: the service contract
// distinguishes create (duplicate_id) from update (provider_not_found) and the client method takes
// it (`customProvidersSave({ provider, apiKey?, mode })`). New RPC, no old clients.
// `apiKey` absent = keep the stored key, "" = delete it, otherwise replace it (spec 34.7).
export const SaveApiProviderSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9-]*$/),
  label: z.string().min(1),
  description: z.string().optional(),
  protocol: ApiProtocolSchema,
  baseUrl: z.string().regex(/^https?:\/\//),
  via: ApiRouteSchema.optional(),
  sshServerId: z.string().optional(),
  models: z.array(ApiProviderModelSchema).optional(),
  enabled: z.boolean().optional(),
  order: z.number().int().optional(),
});
export type SaveApiProvider = z.infer<typeof SaveApiProviderSchema>;

export const CustomProvidersSaveRequestSchema = req("providers.custom.save.request", {
  mode: z.enum(["create", "update"]),
  provider: SaveApiProviderSchema,
  apiKey: z.string().optional(),
});
export const CustomProvidersSaveResponseSchema = resp("providers.custom.save.response", {
  provider: ApiProviderRecordSchema.nullable(),
});

export const CustomProvidersDeleteRequestSchema = req("providers.custom.delete.request", {
  id: z.string().min(1),
});
export const CustomProvidersDeleteResponseSchema = resp("providers.custom.delete.response", {});

// Explicit `apiKey` tests an unsaved provider; `id` tests with the stored key of that provider.
export const TestApiProviderSchema = z.object({
  protocol: ApiProtocolSchema,
  baseUrl: z.string().regex(/^https?:\/\//),
  via: ApiRouteSchema.optional(),
  sshServerId: z.string().optional(),
  apiKey: z.string().optional(),
  id: z.string().optional(),
});
export type TestApiProvider = z.infer<typeof TestApiProviderSchema>;

export const CustomProvidersTestRequestSchema = req("providers.custom.test.request", {
  protocol: ApiProtocolSchema,
  baseUrl: z.string().regex(/^https?:\/\//),
  via: ApiRouteSchema.optional(),
  sshServerId: z.string().optional(),
  apiKey: z.string().optional(),
  id: z.string().optional(),
});
export const CustomProvidersTestResponseSchema = resp("providers.custom.test.response", {
  result: ProviderTestResultSchema.nullable(),
});

export const CustomProvidersRequestSchemas = [
  CustomProvidersListRequestSchema,
  CustomProvidersSaveRequestSchema,
  CustomProvidersDeleteRequestSchema,
  CustomProvidersTestRequestSchema,
] as const;

export const CustomProvidersResponseSchemas = [
  CustomProvidersListResponseSchema,
  CustomProvidersSaveResponseSchema,
  CustomProvidersDeleteResponseSchema,
  CustomProvidersTestResponseSchema,
] as const;
