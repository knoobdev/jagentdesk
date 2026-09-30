import { z } from "zod";

/**
 * What a daemon host can run (spec 24.2, ADR-0024). Reported in
 * `server_info.capabilities.host` and re-broadcast when it changes, so apps show
 * features only where they work and agents only get tools that can succeed.
 */
export const HOST_CAPABILITY_IDS = [
  "iosSimulators",
  "androidDevices",
  "docker",
  "helm",
  "proxySystemCapture",
  "frida",
  "tunnel",
  "maestro",
  "java",
  "forgeGh",
  "forgeGlab",
  "forgeTea",
] as const;
export type HostCapabilityId = (typeof HOST_CAPABILITY_IDS)[number];

export const HostCapabilityStateSchema = z.enum([
  "available",
  "missing_tool",
  "not_running",
  "unsupported_os",
]);
export type HostCapabilityState = z.infer<typeof HostCapabilityStateSchema>;

export const HostCapabilitySchema = z.object({
  state: HostCapabilityStateSchema,
  /** Why the capability is not available (English UI string); "" when available. */
  reason: z.string(),
  /** Version of the main tool, when known. */
  version: z.string().nullable(),
  /** Tool ids the platform-aware installer can install to make this available. */
  installable: z.array(z.string()),
});
export type HostCapability = z.infer<typeof HostCapabilitySchema>;

/** Keyed by {@link HostCapabilityId}; a record so newer daemons can add ids. */
export const HostCapabilitiesSchema = z.record(z.string(), HostCapabilitySchema);
export type HostCapabilities = z.infer<typeof HostCapabilitiesSchema>;

/** A capability counts as present on a host unless its OS cannot run it at all. */
export function isHostCapabilitySupported(
  capabilities: HostCapabilities | null | undefined,
  id: HostCapabilityId,
): boolean {
  const capability = capabilities?.[id];
  return capability !== undefined && capability.state !== "unsupported_os";
}

// ── RPC ──────────────────────────────────────────────────────────────────────
export const HostCapabilitiesRefreshRequestSchema = z.object({
  type: z.literal("host.capabilities.refresh.request"),
  requestId: z.string(),
});
export const HostCapabilitiesRefreshResponseSchema = z.object({
  type: z.literal("host.capabilities.refresh.response"),
  payload: z.object({
    requestId: z.string(),
    capabilities: HostCapabilitiesSchema,
  }),
});
export type HostCapabilitiesRefreshRequest = z.infer<typeof HostCapabilitiesRefreshRequestSchema>;

// ── Platform-aware tool installer (spec 24.3, 24.8) ─────────────────────────
export const ToolInstallPlanSchema = z.object({
  planId: z.string(),
  tool: z.string(),
  version: z.string().nullable(),
  /** present: already installed · manual: only instructions in `notes`. */
  method: z.enum(["present", "package-manager", "release", "manual"]),
  manager: z.enum(["brew", "winget", "scoop"]).nullable(),
  command: z.array(z.string()).nullable(),
  url: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  checksum: z.literal("sha256").nullable(),
  destination: z.string().nullable(),
  notes: z.array(z.string()),
});
export type ToolInstallPlan = z.infer<typeof ToolInstallPlanSchema>;

export const HostToolsPlanRequestSchema = z.object({
  type: z.literal("host.tools.plan.request"),
  requestId: z.string(),
  tool: z.string().min(1),
});
export const HostToolsPlanResponseSchema = z.object({
  type: z.literal("host.tools.plan.response"),
  payload: z.object({
    requestId: z.string(),
    plan: ToolInstallPlanSchema.nullable(),
    error: z.object({ code: z.string(), message: z.string() }).nullable(),
  }),
});

export const HostToolsInstallRequestSchema = z.object({
  type: z.literal("host.tools.install.request"),
  requestId: z.string(),
  planId: z.string().min(1),
});
export const HostToolsInstallResponseSchema = z.object({
  type: z.literal("host.tools.install.response"),
  payload: z.object({
    requestId: z.string(),
    ok: z.boolean(),
    version: z.string().nullable(),
    path: z.string().nullable(),
    error: z.object({ code: z.string(), message: z.string() }).nullable(),
  }),
});
export const HostToolsInstallProgressSchema = z.object({
  type: z.literal("host.tools.install.progress"),
  payload: z.object({ requestId: z.string(), planId: z.string(), line: z.string() }),
});
