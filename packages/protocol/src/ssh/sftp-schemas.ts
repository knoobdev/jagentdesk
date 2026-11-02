import { z } from "zod";
import { sshModuleRequest as req, sshModuleResponse as resp } from "./module-rpc.js";

// SFTP and the transfer queue (spec 25.5, milestone S2). Each pane of the two-pane browser is an
// endpoint: the daemon machine's own file system, or one saved server over its SFTP channel.
// Daemon paths use the daemon OS's separators; server paths are POSIX.

export const SftpEndpointSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("daemon") }),
  z.object({ kind: z.literal("server"), serverId: z.string() }),
]);
export type SftpEndpoint = z.infer<typeof SftpEndpointSchema>;

export const SftpEntryKindSchema = z.enum(["file", "directory", "symlink", "other"]);
export type SftpEntryKind = z.infer<typeof SftpEntryKindSchema>;

export const SftpEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  kind: SftpEntryKindSchema,
  size: z.number().int().nonnegative(),
  modifiedAtMs: z.number(),
  /** Permission bits only (`mode & 0o7777`). */
  mode: z.number().int().nonnegative(),
  /** `ls -l` style, e.g. `rwxr-xr-x`. */
  permissions: z.string(),
  /** Kind of the symlink target; absent for non-links or dangling links. */
  linkTargetKind: SftpEntryKindSchema.optional(),
});
export type SftpEntry = z.infer<typeof SftpEntrySchema>;

export const SftpConflictPolicySchema = z.enum(["replace", "keep-both", "skip"]);
export type SftpConflictPolicy = z.infer<typeof SftpConflictPolicySchema>;

// `revision` is the SHA-256 of the content the client opened; writing with it detects a file
// that changed on the server since it was opened (spec 25.5 "hỏi ghi đè").
export const SftpFileVersionSchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  modifiedAtMs: z.number(),
  revision: z.string(),
});
export type SftpFileVersion = z.infer<typeof SftpFileVersionSchema>;

export const SftpOpenedFileSchema = z.object({
  content: z.string(),
  hasBom: z.boolean(),
  version: SftpFileVersionSchema,
});
export type SftpOpenedFile = z.infer<typeof SftpOpenedFileSchema>;

export const SftpWriteResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("written"), version: SftpFileVersionSchema }),
  z.object({ status: z.literal("conflict"), current: SftpFileVersionSchema.nullable() }),
]);
export type SftpWriteResult = z.infer<typeof SftpWriteResultSchema>;

export const SshTransferStatusSchema = z.enum([
  "queued",
  "running",
  "paused",
  "conflict",
  "completed",
  "skipped",
  "failed",
  "cancelled",
]);
export type SshTransferStatus = z.infer<typeof SshTransferStatusSchema>;

export const SshTransferSchema = z.object({
  id: z.string(),
  source: SftpEndpointSchema,
  sourcePath: z.string(),
  target: SftpEndpointSchema,
  /** Final destination path (already renamed when the conflict policy was `keep-both`). */
  targetPath: z.string(),
  kind: z.enum(["file", "directory"]),
  status: SshTransferStatusSchema,
  conflict: SftpConflictPolicySchema.optional(),
  bytesTotal: z.number().int().nonnegative(),
  bytesTransferred: z.number().int().nonnegative(),
  filesTotal: z.number().int().nonnegative(),
  filesDone: z.number().int().nonnegative(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
});
export type SshTransfer = z.infer<typeof SshTransferSchema>;

// ── file operations ──
export const SshSftpListRequestSchema = req("ssh.sftp.list.request", {
  endpoint: SftpEndpointSchema,
  /** Absolute path; empty string means the endpoint's home directory. */
  path: z.string(),
  showHidden: z.boolean().optional(),
});
export const SshSftpListResponseSchema = resp("ssh.sftp.list.response", {
  path: z.string().nullable(),
  parentPath: z.string().nullable(),
  entries: z.array(SftpEntrySchema),
});

export const SshSftpStatRequestSchema = req("ssh.sftp.stat.request", {
  endpoint: SftpEndpointSchema,
  path: z.string(),
});
export const SshSftpStatResponseSchema = resp("ssh.sftp.stat.response", {
  entry: SftpEntrySchema.nullable(),
});

export const SshSftpMkdirRequestSchema = req("ssh.sftp.mkdir.request", {
  endpoint: SftpEndpointSchema,
  path: z.string(),
});
export const SshSftpMkdirResponseSchema = resp("ssh.sftp.mkdir.response", {});

export const SshSftpRenameRequestSchema = req("ssh.sftp.rename.request", {
  endpoint: SftpEndpointSchema,
  fromPath: z.string(),
  toPath: z.string(),
});
export const SshSftpRenameResponseSchema = resp("ssh.sftp.rename.response", {});

// Directories are deleted recursively.
export const SshSftpDeleteRequestSchema = req("ssh.sftp.delete.request", {
  endpoint: SftpEndpointSchema,
  path: z.string(),
});
export const SshSftpDeleteResponseSchema = resp("ssh.sftp.delete.response", {});

export const SshSftpChmodRequestSchema = req("ssh.sftp.chmod.request", {
  endpoint: SftpEndpointSchema,
  path: z.string(),
  /** Octal string, e.g. "755" or "0644". */
  mode: z.string().regex(/^[0-7]{3,4}$/),
});
export const SshSftpChmodResponseSchema = resp("ssh.sftp.chmod.response", {});

// Opens a text file for the code editor (at most 5 MB, UTF-8).
export const SshSftpReadRequestSchema = req("ssh.sftp.read.request", {
  endpoint: SftpEndpointSchema,
  path: z.string(),
});
export const SshSftpReadResponseSchema = resp("ssh.sftp.read.response", {
  file: SftpOpenedFileSchema.nullable(),
});

// Without `expectedRevision` the write always overwrites (the user confirmed "overwrite").
export const SshSftpWriteRequestSchema = req("ssh.sftp.write.request", {
  endpoint: SftpEndpointSchema,
  path: z.string(),
  content: z.string(),
  hasBom: z.boolean().optional(),
  expectedRevision: z.string().optional(),
});
export const SshSftpWriteResponseSchema = resp("ssh.sftp.write.response", {
  result: SftpWriteResultSchema.nullable(),
});

// Copies between the two panes (daemon↔server, server↔server) through the transfer queue.
// Without `conflict`, a transfer whose target exists stops in status `conflict` until
// ssh.transfer.start resolves it.
export const SshSftpCopyRequestSchema = req("ssh.sftp.copy.request", {
  source: SftpEndpointSchema,
  sourcePaths: z.array(z.string()).min(1),
  target: SftpEndpointSchema,
  /** Empty string means the target endpoint's home directory. */
  targetDir: z.string(),
  conflict: SftpConflictPolicySchema.optional(),
});
export const SshSftpCopyResponseSchema = resp("ssh.sftp.copy.response", {
  transfers: z.array(SshTransferSchema),
});

// Download to the device: the daemon first copies the server file into a staging directory,
// then the app fetches it with the existing file_download_token_request { cwd, path }.
export const SshSftpDownloadRequestSchema = req("ssh.sftp.download.request", {
  endpoint: SftpEndpointSchema,
  path: z.string(),
});
export const SshSftpDownloadResponseSchema = resp("ssh.sftp.download.response", {
  transfer: SshTransferSchema.nullable(),
  /** `cwd` and `path` to pass to file_download_token_request once the transfer completes. */
  download: z.object({ cwd: z.string(), path: z.string() }).nullable(),
});

// ── transfer queue ──
export const SshTransferListRequestSchema = req("ssh.transfer.list.request", {});
export const SshTransferListResponseSchema = resp("ssh.transfer.list.response", {
  transfers: z.array(SshTransferSchema),
});

// (Re)starts a transfer in `conflict`, `failed` or `cancelled`; `conflict` resolves a conflict.
export const SshTransferStartRequestSchema = req("ssh.transfer.start.request", {
  transferId: z.string(),
  conflict: SftpConflictPolicySchema.optional(),
});
export const SshTransferStartResponseSchema = resp("ssh.transfer.start.response", {
  transfer: SshTransferSchema.nullable(),
});

export const SshTransferPauseRequestSchema = req("ssh.transfer.pause.request", {
  transferId: z.string(),
});
export const SshTransferPauseResponseSchema = resp("ssh.transfer.pause.response", {
  transfer: SshTransferSchema.nullable(),
});

// Continues from the byte offset already written to the target.
export const SshTransferResumeRequestSchema = req("ssh.transfer.resume.request", {
  transferId: z.string(),
});
export const SshTransferResumeResponseSchema = resp("ssh.transfer.resume.response", {
  transfer: SshTransferSchema.nullable(),
});

export const SshTransferCancelRequestSchema = req("ssh.transfer.cancel.request", {
  transferId: z.string(),
});
export const SshTransferCancelResponseSchema = resp("ssh.transfer.cancel.response", {
  transfer: SshTransferSchema.nullable(),
});

// Removes a finished (completed/skipped/failed/cancelled) transfer from the queue.
export const SshTransferDismissRequestSchema = req("ssh.transfer.dismiss.request", {
  transferId: z.string(),
});
export const SshTransferDismissResponseSchema = resp("ssh.transfer.dismiss.response", {});

// ── push ──
// Sent to every client on each status change and at most every 250 ms while bytes move.
export const SshTransferProgressSchema = z.object({
  type: z.literal("ssh.transfer.progress"),
  transfer: SshTransferSchema,
});
export type SshTransferProgress = z.infer<typeof SshTransferProgressSchema>;

export const SftpInboundSchemas = [
  SshSftpListRequestSchema,
  SshSftpStatRequestSchema,
  SshSftpMkdirRequestSchema,
  SshSftpRenameRequestSchema,
  SshSftpDeleteRequestSchema,
  SshSftpChmodRequestSchema,
  SshSftpReadRequestSchema,
  SshSftpWriteRequestSchema,
  SshSftpCopyRequestSchema,
  SshSftpDownloadRequestSchema,
  SshTransferListRequestSchema,
  SshTransferStartRequestSchema,
  SshTransferPauseRequestSchema,
  SshTransferResumeRequestSchema,
  SshTransferCancelRequestSchema,
  SshTransferDismissRequestSchema,
] as const;

export const SftpOutboundSchemas = [
  SshSftpListResponseSchema,
  SshSftpStatResponseSchema,
  SshSftpMkdirResponseSchema,
  SshSftpRenameResponseSchema,
  SshSftpDeleteResponseSchema,
  SshSftpChmodResponseSchema,
  SshSftpReadResponseSchema,
  SshSftpWriteResponseSchema,
  SshSftpCopyResponseSchema,
  SshSftpDownloadResponseSchema,
  SshTransferListResponseSchema,
  SshTransferStartResponseSchema,
  SshTransferPauseResponseSchema,
  SshTransferResumeResponseSchema,
  SshTransferCancelResponseSchema,
  SshTransferDismissResponseSchema,
  SshTransferProgressSchema,
] as const;

export const SftpInboundMessageSchema = z.discriminatedUnion("type", [...SftpInboundSchemas]);
export type SftpInboundMessage = z.infer<typeof SftpInboundMessageSchema>;
export const SftpOutboundMessageSchema = z.discriminatedUnion("type", [...SftpOutboundSchemas]);
export type SftpOutboundMessage = z.infer<typeof SftpOutboundMessageSchema>;
