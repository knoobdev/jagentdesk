import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Host-to-host data migration bundle.
//
// A `HostDataBundle` is a self-contained snapshot exported by one daemon (the
// SOURCE) and imported into another daemon (the TARGET). It carries the parts of
// an agent that the daemon owns and can serialize deterministically:
//
//   - the stored agent record (metadata / config / labels / usage / persistence)
//   - the project + workspace rows the agent lives in
//   - a best-effort copy of the provider-native conversation history, WHERE that
//     history is readable on the source machine (see `historyPortable`).
//
// The daemon does NOT own conversation history: it lives inside each provider
// CLI's own storage (e.g. `~/.claude/projects/...`). We copy those bytes INLINE
// into the bundle. Whether they can be *rehydrated* on an arbitrary target
// machine depends on the provider: session files embed machine-local absolute
// paths and are keyed by an encoding of the cwd. For providers whose on-disk
// layout the daemon can reproduce deterministically (currently Claude, via the
// SDK-verbatim project-dir encoder) the target rewrites those embedded paths
// (source cwd/home → target cwd/home) and writes the transcript into place, so
// history crosses machines as long as the target cwd exists. We still never
// claim history was migrated unless it was genuinely materialized on the target
// — see `historyPortable` / `materializeProviderHistory`.
//
// Opaque rows (`record`, projects, workspaces) are kept as pass-through JSON
// objects here so the protocol package does not have to depend on the server's
// storage schemas. The server re-parses them with its own Zod schemas on import.
// ─────────────────────────────────────────────────────────────────────────────

// v1 → v2: history blobs gained per-file `omitted` (oversized transcripts are
// dropped rather than bloating the bundle) and import now rehydrates provider
// history ACROSS machines by rewriting embedded paths, not just same-machine.
export const HOST_DATA_BUNDLE_VERSION = 2 as const;

/**
 * Per-transcript byte cap. Transcripts larger than this are recorded as
 * `omitted: true` with no bytes so a single huge session cannot bloat the
 * bundle; the agent still migrates but its history is flagged unavailable.
 */
export const HISTORY_BLOB_MAX_FILE_BYTES = 8 * 1024 * 1024;

/** Opaque JSON object re-parsed by the server against its own schema. */
const OpaqueRecordSchema = z.record(z.string(), z.unknown());

export const HostDataUsageTotalsSchema = z.object({
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  outputTokens: z.number(),
  totalCostUsd: z.number(),
  turns: z.number(),
});

/**
 * One provider-native session file as read on the SOURCE machine. `name` is the
 * file's basename inside the provider's per-project session directory.
 */
export const HistoryBlobFileSchema = z.object({
  name: z.string(),
  /** base64-encoded raw file bytes. Empty string when `omitted` is true. */
  base64: z.string(),
  /**
   * True when the transcript exceeded HISTORY_BLOB_MAX_FILE_BYTES and its bytes
   * were intentionally left out. The blob still travels (so the source is known
   * to have had history) but the target cannot materialize it and flags the
   * agent's history as unavailable.
   */
  omitted: z.boolean().optional(),
});
export type HistoryBlobFile = z.infer<typeof HistoryBlobFileSchema>;

/**
 * A copy of the provider-native session files as read on the SOURCE machine,
 * carried INLINE. `sourceCwd` (here) plus `HostDataBundle.sourceHome` are what
 * the target uses to rewrite embedded absolute paths before writing the
 * transcript into the provider's storage computed from the TARGET agent's cwd.
 */
export const HistoryBlobSchema = z.object({
  provider: z.string(),
  /** cwd the session was recorded against on the source machine. */
  sourceCwd: z.string(),
  /** Provider session id (matches the stored record's persistence handle). */
  sessionId: z.string(),
  files: z.array(HistoryBlobFileSchema),
});
export type HistoryBlob = z.infer<typeof HistoryBlobSchema>;

export const HostDataBundleAgentEntrySchema = z.object({
  /** Agent id on the SOURCE daemon. Used to build the import id map. */
  oldAgentId: z.string(),
  provider: z.string(),
  /** Stored agent record JSON (STORED_AGENT_SCHEMA on the server). */
  record: OpaqueRecordSchema,
  /** Convenience copy of usage totals; also present inside `record`. */
  usageTotals: HostDataUsageTotalsSchema.nullable(),
  /**
   * True when a provider history blob was captured on the source (the provider's
   * on-disk transcript was located and read). This reports what the SOURCE had to
   * offer, NOT that the TARGET succeeded: whether the transcript actually
   * rehydrates is decided at import time (target cwd must exist; oversized
   * transcripts are omitted). See `materializeProviderHistory`.
   */
  historyPortable: z.boolean(),
  /** Key into `HostDataBundle.historyBlobs`, or null when no blob was captured. */
  historyBlobRef: z.string().nullable(),
});
export type HostDataBundleAgentEntry = z.infer<typeof HostDataBundleAgentEntrySchema>;

export const HostDataBundleSchema = z.object({
  version: z.literal(HOST_DATA_BUNDLE_VERSION),
  sourceServerId: z.string(),
  /** Human label of the source host, used for the migration display prefix. */
  sourceHostLabel: z.string().nullable(),
  /**
   * `os.homedir()` on the source at export time. The target rewrites this prefix
   * to its own home inside captured transcripts so provider history rehydrates
   * even across machines (paths that pointed at the source home now point at the
   * target home). See `materializeProviderHistory`.
   */
  sourceHome: z.string(),
  exportedAt_ms: z.number(),
  projects: z.array(OpaqueRecordSchema),
  workspaces: z.array(OpaqueRecordSchema),
  agents: z.array(HostDataBundleAgentEntrySchema),
  /** ref -> captured provider history blob. */
  historyBlobs: z.record(z.string(), HistoryBlobSchema),
});
export type HostDataBundle = z.infer<typeof HostDataBundleSchema>;

/** Per-agent outcome of materializing provider history on the target. */
export const HostDataImportAgentOutcomeSchema = z.object({
  oldAgentId: z.string(),
  newAgentId: z.string(),
  historyMaterialized: z.boolean(),
});
export type HostDataImportAgentOutcome = z.infer<typeof HostDataImportAgentOutcomeSchema>;

export const HostDataImportResultSchema = z.object({
  sourceServerId: z.string(),
  targetServerId: z.string(),
  sourceHostLabel: z.string().nullable(),
  /** oldAgentId -> newAgentId on the target daemon. */
  idMap: z.record(z.string(), z.string()),
  /** oldWorkspaceId -> newWorkspaceId (identity today; reserved for remaps). */
  workspaceIdMap: z.record(z.string(), z.string()),
  agents: z.array(HostDataImportAgentOutcomeSchema),
  importedAgentCount: z.number(),
  importedProjectCount: z.number(),
  importedWorkspaceCount: z.number(),
  historyMaterializedCount: z.number(),
  historyUnavailableCount: z.number(),
});
export type HostDataImportResult = z.infer<typeof HostDataImportResultSchema>;

// ── Request / response messages ─────────────────────────────────────────────

export const ExportHostDataRequestMessageSchema = z.object({
  type: z.literal("export_host_data_request"),
  requestId: z.string(),
  /** Restrict the export to these source agent ids; omit for the whole daemon. */
  agentIds: z.array(z.string()).optional(),
});
export type ExportHostDataRequestMessage = z.infer<typeof ExportHostDataRequestMessageSchema>;

export const ExportHostDataResponseMessageSchema = z.object({
  type: z.literal("export_host_data_response"),
  payload: z.object({
    requestId: z.string(),
    bundle: HostDataBundleSchema.nullable(),
    error: z.string().nullable(),
  }),
});
export type ExportHostDataResponseMessage = z.infer<typeof ExportHostDataResponseMessageSchema>;

export const ImportHostDataRequestMessageSchema = z.object({
  type: z.literal("import_host_data_request"),
  requestId: z.string(),
  bundle: HostDataBundleSchema,
});
export type ImportHostDataRequestMessage = z.infer<typeof ImportHostDataRequestMessageSchema>;

export const ImportHostDataResponseMessageSchema = z.object({
  type: z.literal("import_host_data_response"),
  payload: z.object({
    requestId: z.string(),
    result: HostDataImportResultSchema.nullable(),
    error: z.string().nullable(),
  }),
});
export type ImportHostDataResponseMessage = z.infer<typeof ImportHostDataResponseMessageSchema>;
