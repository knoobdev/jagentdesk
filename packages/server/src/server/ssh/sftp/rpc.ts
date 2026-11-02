import {
  SftpInboundMessageSchema,
  SftpInboundSchemas,
  type SftpInboundMessage,
  type SftpOutboundMessage,
} from "@jagentdesk/protocol/ssh/sftp-schemas";
import type { SshModuleError } from "@jagentdesk/protocol/ssh/module-rpc";
import { SftpError } from "./file-system.js";
import type { SftpService } from "./service.js";

const INBOUND_TYPES = new Set<string>(SftpInboundSchemas.map((schema) => schema.shape.type.value));

export function toModuleError(error: unknown): SshModuleError {
  if (error instanceof SftpError) return { code: error.code, message: error.message };
  return { code: "failed", message: error instanceof Error ? error.message : String(error) };
}

type Emit = (message: SftpOutboundMessage) => void;

async function respond<T>(
  run: () => Promise<T>,
  ok: (value: T) => void,
  fail: (error: SshModuleError) => void,
): Promise<void> {
  let value: T;
  try {
    value = await run();
  } catch (error) {
    fail(toModuleError(error));
    return;
  }
  ok(value);
}

// Runs one SFTP request and emits its response. Returns false when `message` is not an SFTP RPC.
export async function handleSftpMessage(
  service: SftpService,
  message: { type: string },
  emit: Emit,
): Promise<boolean> {
  if (!INBOUND_TYPES.has(message.type)) return false;
  const parsed = SftpInboundMessageSchema.safeParse(message);
  if (!parsed.success) return false;
  await dispatch(service, parsed.data, emit);
  return true;
}

async function dispatch(service: SftpService, msg: SftpInboundMessage, emit: Emit): Promise<void> {
  const { requestId } = msg;
  switch (msg.type) {
    case "ssh.sftp.list.request":
      return respond(
        () =>
          service.list({
            endpoint: msg.endpoint,
            path: msg.path,
            showHidden: msg.showHidden ?? false,
          }),
        (listing) =>
          emit({ type: "ssh.sftp.list.response", payload: { requestId, error: null, ...listing } }),
        (error) =>
          emit({
            type: "ssh.sftp.list.response",
            payload: { requestId, error, path: null, parentPath: null, entries: [] },
          }),
      );
    case "ssh.sftp.stat.request":
      return respond(
        () => service.stat(msg.endpoint, msg.path),
        (entry) =>
          emit({ type: "ssh.sftp.stat.response", payload: { requestId, error: null, entry } }),
        (error) =>
          emit({ type: "ssh.sftp.stat.response", payload: { requestId, error, entry: null } }),
      );
    case "ssh.sftp.mkdir.request":
      return respond(
        () => service.mkdir(msg.endpoint, msg.path),
        () => emit({ type: "ssh.sftp.mkdir.response", payload: { requestId, error: null } }),
        (error) => emit({ type: "ssh.sftp.mkdir.response", payload: { requestId, error } }),
      );
    case "ssh.sftp.rename.request":
      return respond(
        () => service.rename(msg.endpoint, msg.fromPath, msg.toPath),
        () => emit({ type: "ssh.sftp.rename.response", payload: { requestId, error: null } }),
        (error) => emit({ type: "ssh.sftp.rename.response", payload: { requestId, error } }),
      );
    case "ssh.sftp.delete.request":
      return respond(
        () => service.delete(msg.endpoint, msg.path),
        () => emit({ type: "ssh.sftp.delete.response", payload: { requestId, error: null } }),
        (error) => emit({ type: "ssh.sftp.delete.response", payload: { requestId, error } }),
      );
    case "ssh.sftp.chmod.request":
      return respond(
        () => service.chmod(msg.endpoint, msg.path, msg.mode),
        () => emit({ type: "ssh.sftp.chmod.response", payload: { requestId, error: null } }),
        (error) => emit({ type: "ssh.sftp.chmod.response", payload: { requestId, error } }),
      );
    case "ssh.sftp.read.request":
      return respond(
        () => service.read(msg.endpoint, msg.path),
        (file) =>
          emit({ type: "ssh.sftp.read.response", payload: { requestId, error: null, file } }),
        (error) =>
          emit({ type: "ssh.sftp.read.response", payload: { requestId, error, file: null } }),
      );
    case "ssh.sftp.write.request":
      return respond(
        () =>
          service.write({
            endpoint: msg.endpoint,
            path: msg.path,
            content: msg.content,
            hasBom: msg.hasBom ?? false,
            expectedRevision: msg.expectedRevision,
          }),
        (result) =>
          emit({ type: "ssh.sftp.write.response", payload: { requestId, error: null, result } }),
        (error) =>
          emit({ type: "ssh.sftp.write.response", payload: { requestId, error, result: null } }),
      );
    case "ssh.sftp.copy.request":
      return respond(
        () =>
          service.copy({
            source: msg.source,
            sourcePaths: msg.sourcePaths,
            target: msg.target,
            targetDir: msg.targetDir,
            conflict: msg.conflict,
          }),
        (transfers) =>
          emit({ type: "ssh.sftp.copy.response", payload: { requestId, error: null, transfers } }),
        (error) =>
          emit({ type: "ssh.sftp.copy.response", payload: { requestId, error, transfers: [] } }),
      );
    case "ssh.sftp.download.request":
      return respond(
        () => service.download(msg.endpoint, msg.path),
        ({ transfer, cwd, path }) =>
          emit({
            type: "ssh.sftp.download.response",
            payload: { requestId, error: null, transfer, download: { cwd, path } },
          }),
        (error) =>
          emit({
            type: "ssh.sftp.download.response",
            payload: { requestId, error, transfer: null, download: null },
          }),
      );
    case "ssh.transfer.list.request":
      return respond(
        async () => service.listTransfers(),
        (transfers) =>
          emit({
            type: "ssh.transfer.list.response",
            payload: { requestId, error: null, transfers },
          }),
        (error) =>
          emit({
            type: "ssh.transfer.list.response",
            payload: { requestId, error, transfers: [] },
          }),
      );
    case "ssh.transfer.start.request":
      return respond(
        async () => service.startTransfer(msg.transferId, msg.conflict),
        (transfer) =>
          emit({
            type: "ssh.transfer.start.response",
            payload: { requestId, error: null, transfer },
          }),
        (error) =>
          emit({
            type: "ssh.transfer.start.response",
            payload: { requestId, error, transfer: null },
          }),
      );
    case "ssh.transfer.pause.request":
      return respond(
        async () => service.pauseTransfer(msg.transferId),
        (transfer) =>
          emit({
            type: "ssh.transfer.pause.response",
            payload: { requestId, error: null, transfer },
          }),
        (error) =>
          emit({
            type: "ssh.transfer.pause.response",
            payload: { requestId, error, transfer: null },
          }),
      );
    case "ssh.transfer.resume.request":
      return respond(
        async () => service.resumeTransfer(msg.transferId),
        (transfer) =>
          emit({
            type: "ssh.transfer.resume.response",
            payload: { requestId, error: null, transfer },
          }),
        (error) =>
          emit({
            type: "ssh.transfer.resume.response",
            payload: { requestId, error, transfer: null },
          }),
      );
    case "ssh.transfer.cancel.request":
      return respond(
        async () => service.cancelTransfer(msg.transferId),
        (transfer) =>
          emit({
            type: "ssh.transfer.cancel.response",
            payload: { requestId, error: null, transfer },
          }),
        (error) =>
          emit({
            type: "ssh.transfer.cancel.response",
            payload: { requestId, error, transfer: null },
          }),
      );
    case "ssh.transfer.dismiss.request":
      return respond(
        () => service.dismissTransfer(msg.transferId),
        () => emit({ type: "ssh.transfer.dismiss.response", payload: { requestId, error: null } }),
        (error) => emit({ type: "ssh.transfer.dismiss.response", payload: { requestId, error } }),
      );
  }
}
