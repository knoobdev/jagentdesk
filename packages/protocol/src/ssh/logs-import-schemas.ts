import { z } from "zod";

// Wire schemas for SSH milestone S6 (spec 25.8, 25.9, 25.12): session logs with
// bookmarks, importing ~/.ssh and CSV, and installing a public key on a server.
// Same envelope as ssh/rpc-schemas.ts.

function req<T extends string, S extends z.ZodRawShape>(type: T, extra: S) {
  return z.object({ type: z.literal(type), requestId: z.string(), ...extra });
}
function resp<T extends string, S extends z.ZodRawShape>(type: T, extra: S) {
  return z.object({
    type: z.literal(type),
    payload: z.object({ requestId: z.string(), error: z.string().nullable(), ...extra }),
  });
}

// ── session logs (spec 25.8) ──
// One recent log per server (`logs/<serverId>.log`, at most 10 MB, a new session
// replaces it) and permanent bookmarks with a comment (`logs/bookmarks/`). Text is
// terminal output with escape sequences removed.

export const SshSessionLogSchema = z.object({
  serverId: z.string(),
  sessionStartedAtMs: z.number(),
  updatedAtMs: z.number(),
  sizeBytes: z.number().int(),
  recording: z.boolean(), // a session is writing to it right now
});
export type SshSessionLog = z.infer<typeof SshSessionLogSchema>;

export const SshLogBookmarkSchema = z.object({
  id: z.string(), // `bmk_…`
  serverId: z.string(),
  comment: z.string(),
  createdAtMs: z.number(),
  sessionStartedAtMs: z.number(),
  sizeBytes: z.number().int(),
});
export type SshLogBookmark = z.infer<typeof SshLogBookmarkSchema>;

export const SshLogSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("recent"), serverId: z.string() }),
  z.object({ kind: z.literal("bookmark"), bookmarkId: z.string() }),
]);
export type SshLogSource = z.infer<typeof SshLogSourceSchema>;

export const SshLogSearchMatchSchema = z.object({
  lineNumber: z.number().int(), // 1-based
  byteOffset: z.number().int(), // where the line starts, for ssh.logs.read
  column: z.number().int(), // 0-based, in characters
  line: z.string(), // the matching line, cut to 400 characters
});
export type SshLogSearchMatch = z.infer<typeof SshLogSearchMatchSchema>;

export const SshLogsListRequestSchema = req("ssh.logs.list.request", {});
export const SshLogsListResponseSchema = resp("ssh.logs.list.response", {
  logs: z.array(SshSessionLogSchema),
  bookmarks: z.array(SshLogBookmarkSchema),
  enabledServerIds: z.array(z.string()),
});
// Logging is off by default per server (spec 25.8).
export const SshLogsSetEnabledRequestSchema = req("ssh.logs.set_enabled.request", {
  serverId: z.string(),
  enabled: z.boolean(),
});
export const SshLogsSetEnabledResponseSchema = resp("ssh.logs.set_enabled.response", {});
// Reads a byte window; `text` never splits a UTF-8 character, so `nextOffset` may be
// a few bytes short of offset + length.
export const SshLogsReadRequestSchema = req("ssh.logs.read.request", {
  source: SshLogSourceSchema,
  offset: z.number().int().min(0).optional(), // default: the last window of the log
  length: z.number().int().positive().max(1_048_576).optional(), // default 262144
});
export const SshLogsReadResponseSchema = resp("ssh.logs.read.response", {
  text: z.string(),
  offset: z.number().int(),
  nextOffset: z.number().int(),
  totalBytes: z.number().int(),
});
export const SshLogsSearchRequestSchema = req("ssh.logs.search.request", {
  source: SshLogSourceSchema,
  query: z.string().min(1),
  caseSensitive: z.boolean().optional(),
});
export const SshLogsSearchResponseSchema = resp("ssh.logs.search.response", {
  matches: z.array(SshLogSearchMatchSchema),
  truncated: z.boolean(), // more than 500 matches
});
// Keeps the server's current log permanently; while that session still records, the
// bookmark keeps receiving its output until the session ends.
export const SshLogsBookmarkRequestSchema = req("ssh.logs.bookmark.request", {
  serverId: z.string(),
  comment: z.string(),
});
export const SshLogsBookmarkResponseSchema = resp("ssh.logs.bookmark.response", {
  bookmark: SshLogBookmarkSchema.nullable(),
});
export const SshLogsUpdateBookmarkRequestSchema = req("ssh.logs.update_bookmark.request", {
  id: z.string(),
  comment: z.string(),
});
export const SshLogsUpdateBookmarkResponseSchema = resp("ssh.logs.update_bookmark.response", {
  bookmark: SshLogBookmarkSchema.nullable(),
});

// ── import (spec 25.9) ──
// `ssh_directory` reads the daemon user's ~/.ssh (config, known_hosts, key files);
// private keys are read by the daemon and never travel to the app. `ssh_config` and
// `csv` take pasted text. Apply re-reads the same source, so preview and apply see
// the same data without holding state between them.

export const SshImportSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ssh_directory") }),
  z.object({ kind: z.literal("ssh_config"), text: z.string() }),
  z.object({ kind: z.literal("csv"), text: z.string() }),
]);
export type SshImportSource = z.infer<typeof SshImportSourceSchema>;

export const SshImportLocationSchema = z.object({
  file: z.string(), // e.g. "~/.ssh/config", "servers.csv"
  line: z.number().int(), // 1-based
});
export type SshImportLocation = z.infer<typeof SshImportLocationSchema>;

export const SshImportIssueCodeSchema = z.enum([
  "wildcard_host",
  "match_block",
  "include",
  "proxy_command",
  "hashed_host",
  "known_host_marker",
  "invalid_line",
  "invalid_row",
  "unknown_jump_host",
]);
export type SshImportIssueCode = z.infer<typeof SshImportIssueCodeSchema>;

export const SshImportIssueSchema = z.object({
  location: SshImportLocationSchema,
  severity: z.enum(["skipped", "error"]),
  code: SshImportIssueCodeSchema,
  message: z.string(),
});
export type SshImportIssue = z.infer<typeof SshImportIssueSchema>;

// One hop of a ProxyJump chain; `alias` is set when it names another imported Host.
export const SshImportJumpHopSchema = z.object({
  alias: z.string().optional(),
  address: z.string(),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().optional(),
});
export type SshImportJumpHop = z.infer<typeof SshImportJumpHopSchema>;

export const SshImportDraftStatusSchema = z.enum(["new", "duplicate"]);
export type SshImportDraftStatus = z.infer<typeof SshImportDraftStatusSchema>;

export const SshImportServerDraftSchema = z.object({
  draftId: z.string(), // `<file>:<line>[:<alias>]`, stable across preview and apply
  alias: z.string(), // ssh_config Host name; CSV label
  label: z.string(),
  address: z.string(),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().optional(),
  groupPath: z.array(z.string()), // nested group labels, outermost first
  tags: z.array(z.string()),
  identityFile: z.string().optional(), // path on the daemon machine
  jumpChain: z.array(SshImportJumpHopSchema),
  location: SshImportLocationSchema,
  status: SshImportDraftStatusSchema,
  duplicateOfServerId: z.string().optional(),
});
export type SshImportServerDraft = z.infer<typeof SshImportServerDraftSchema>;

export const SshImportKnownHostDraftSchema = z.object({
  host: z.string(),
  port: z.number().int(),
  keyType: z.string(),
  publicKey: z.string(), // base64 key blob
  fingerprintSha256: z.string(),
  location: SshImportLocationSchema,
  status: SshImportDraftStatusSchema,
});
export type SshImportKnownHostDraft = z.infer<typeof SshImportKnownHostDraftSchema>;

export const SshImportKeyDraftSchema = z.object({
  path: z.string(),
  label: z.string(),
  keyType: z.string(), // wire name, e.g. "ssh-ed25519"; "" when encrypted with no .pub
  fingerprintSha256: z.string().nullable(),
  encrypted: z.boolean(), // needs a passphrase in ssh.import.apply
  status: SshImportDraftStatusSchema,
});
export type SshImportKeyDraft = z.infer<typeof SshImportKeyDraftSchema>;

export const SshImportPreviewSchema = z.object({
  servers: z.array(SshImportServerDraftSchema),
  knownHosts: z.array(SshImportKnownHostDraftSchema),
  keys: z.array(SshImportKeyDraftSchema),
  issues: z.array(SshImportIssueSchema),
});
export type SshImportPreview = z.infer<typeof SshImportPreviewSchema>;

export const SshImportFailureSchema = z.object({
  location: SshImportLocationSchema,
  message: z.string(),
});
export type SshImportFailure = z.infer<typeof SshImportFailureSchema>;

export const SshImportCountsSchema = z.object({
  added: z.number().int(),
  duplicates: z.number().int(), // skipped because they already exist
  failed: z.array(SshImportFailureSchema),
});
export type SshImportCounts = z.infer<typeof SshImportCountsSchema>;

export const SshImportResultSchema = z.object({
  servers: SshImportCountsSchema,
  knownHosts: SshImportCountsSchema,
  keys: SshImportCountsSchema,
  issues: z.array(SshImportIssueSchema), // skipped entries (ProxyCommand, wildcards…)
});
export type SshImportResult = z.infer<typeof SshImportResultSchema>;

export const SshImportPreviewRequestSchema = req("ssh.import.preview.request", {
  source: SshImportSourceSchema,
});
export const SshImportPreviewResponseSchema = resp("ssh.import.preview.response", {
  preview: SshImportPreviewSchema.nullable(),
});
export const SshImportApplyRequestSchema = req("ssh.import.apply.request", {
  source: SshImportSourceSchema,
  // Absent → every new server draft. Jump hosts they reference are added too.
  serverDraftIds: z.array(z.string()).optional(),
  importKnownHosts: z.boolean(),
  keyPaths: z.array(z.string()),
  // Passphrase per encrypted key path; used once to import, kept in the secret store.
  passphrases: z.record(z.string(), z.string()).optional(),
});
export const SshImportApplyResponseSchema = resp("ssh.import.apply.response", {
  result: SshImportResultSchema.nullable(),
});

// ── install public key (spec 25.12 `ssh.keys.install_to_server`, 25.16 #3) ──

export const SshKeyInstallOutcomeSchema = z.enum(["installed", "already_present"]);
export type SshKeyInstallOutcome = z.infer<typeof SshKeyInstallOutcomeSchema>;

export const SshKeysInstallToServerRequestSchema = req("ssh.keys.install_to_server.request", {
  keyId: z.string(),
  serverId: z.string(),
  directory: z.string().optional(), // default "~/.ssh"
  filename: z.string().optional(), // default "authorized_keys"
});
export const SshKeysInstallToServerResponseSchema = resp("ssh.keys.install_to_server.response", {
  outcome: SshKeyInstallOutcomeSchema.nullable(),
  path: z.string().nullable(), // remote path written, e.g. ".ssh/authorized_keys"
});

export const LogsImportInboundSchemas = [
  SshLogsListRequestSchema,
  SshLogsSetEnabledRequestSchema,
  SshLogsReadRequestSchema,
  SshLogsSearchRequestSchema,
  SshLogsBookmarkRequestSchema,
  SshLogsUpdateBookmarkRequestSchema,
  SshImportPreviewRequestSchema,
  SshImportApplyRequestSchema,
  SshKeysInstallToServerRequestSchema,
] as const;

export const LogsImportOutboundSchemas = [
  SshLogsListResponseSchema,
  SshLogsSetEnabledResponseSchema,
  SshLogsReadResponseSchema,
  SshLogsSearchResponseSchema,
  SshLogsBookmarkResponseSchema,
  SshLogsUpdateBookmarkResponseSchema,
  SshImportPreviewResponseSchema,
  SshImportApplyResponseSchema,
  SshKeysInstallToServerResponseSchema,
] as const;

export const LogsImportInboundMessageSchema = z.discriminatedUnion("type", [
  ...LogsImportInboundSchemas,
]);
export type LogsImportInboundMessage = z.infer<typeof LogsImportInboundMessageSchema>;

export const LogsImportOutboundMessageSchema = z.discriminatedUnion("type", [
  ...LogsImportOutboundSchemas,
]);
export type LogsImportOutboundMessage = z.infer<typeof LogsImportOutboundMessageSchema>;
