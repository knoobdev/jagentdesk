import {
  LogsImportInboundMessageSchema,
  LogsImportInboundSchemas,
  type LogsImportInboundMessage,
  type LogsImportOutboundMessage,
} from "@jagentdesk/protocol/ssh/logs-import-schemas";
import type { SshImporter } from "./importer.js";
import type { KeyInstallService } from "./install-key.js";
import type { SessionLogService } from "./session-log.js";

export interface LogsImportServices {
  logs: SessionLogService;
  importer: SshImporter;
  keys: KeyInstallService;
}

const INBOUND_TYPES = new Set<string>(
  LogsImportInboundSchemas.map((schema) => schema.shape.type.value),
);

type Emit = (message: LogsImportOutboundMessage) => void;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function respond<T>(
  run: () => Promise<T>,
  ok: (value: T) => void,
  fail: (error: string) => void,
): Promise<void> {
  let value: T;
  try {
    value = await run();
  } catch (error) {
    fail(messageOf(error));
    return;
  }
  ok(value);
}

// Runs one ssh.logs.* / ssh.import.* / ssh.keys.install_to_server request and emits its
// response. Returns false when `message` is not one of them.
export async function handleLogsImportMessage(
  services: LogsImportServices,
  message: { type: string },
  emit: Emit,
): Promise<boolean> {
  if (!INBOUND_TYPES.has(message.type)) return false;
  const parsed = LogsImportInboundMessageSchema.safeParse(message);
  if (!parsed.success) return false;
  await dispatch(services, parsed.data, emit);
  return true;
}

async function dispatch(
  { logs, importer, keys }: LogsImportServices,
  msg: LogsImportInboundMessage,
  emit: Emit,
): Promise<void> {
  const { requestId } = msg;
  switch (msg.type) {
    case "ssh.logs.list.request":
      return respond(
        () => logs.list(),
        (listing) =>
          emit({ type: "ssh.logs.list.response", payload: { requestId, error: null, ...listing } }),
        (error) =>
          emit({
            type: "ssh.logs.list.response",
            payload: { requestId, error, logs: [], bookmarks: [], enabledServerIds: [] },
          }),
      );
    case "ssh.logs.set_enabled.request":
      return respond(
        () => logs.setEnabled(msg.serverId, msg.enabled),
        () => emit({ type: "ssh.logs.set_enabled.response", payload: { requestId, error: null } }),
        (error) => emit({ type: "ssh.logs.set_enabled.response", payload: { requestId, error } }),
      );
    case "ssh.logs.read.request":
      return respond(
        () => logs.read(msg.source, msg.offset, msg.length),
        (window) =>
          emit({ type: "ssh.logs.read.response", payload: { requestId, error: null, ...window } }),
        (error) =>
          emit({
            type: "ssh.logs.read.response",
            payload: { requestId, error, text: "", offset: 0, nextOffset: 0, totalBytes: 0 },
          }),
      );
    case "ssh.logs.search.request":
      return respond(
        () => logs.search(msg.source, msg.query, { caseSensitive: msg.caseSensitive }),
        (found) =>
          emit({ type: "ssh.logs.search.response", payload: { requestId, error: null, ...found } }),
        (error) =>
          emit({
            type: "ssh.logs.search.response",
            payload: { requestId, error, matches: [], truncated: false },
          }),
      );
    case "ssh.logs.bookmark.request":
      return respond(
        () => logs.bookmark(msg.serverId, msg.comment),
        (bookmark) =>
          emit({
            type: "ssh.logs.bookmark.response",
            payload: { requestId, error: null, bookmark },
          }),
        (error) =>
          emit({
            type: "ssh.logs.bookmark.response",
            payload: { requestId, error, bookmark: null },
          }),
      );
    case "ssh.logs.update_bookmark.request":
      return respond(
        () => logs.updateBookmark(msg.id, msg.comment),
        (bookmark) =>
          emit({
            type: "ssh.logs.update_bookmark.response",
            payload: { requestId, error: null, bookmark },
          }),
        (error) =>
          emit({
            type: "ssh.logs.update_bookmark.response",
            payload: { requestId, error, bookmark: null },
          }),
      );
    case "ssh.import.preview.request":
      return respond(
        () => importer.preview(msg.source),
        (preview) =>
          emit({
            type: "ssh.import.preview.response",
            payload: { requestId, error: null, preview },
          }),
        (error) =>
          emit({
            type: "ssh.import.preview.response",
            payload: { requestId, error, preview: null },
          }),
      );
    case "ssh.import.apply.request":
      return respond(
        () =>
          importer.apply({
            source: msg.source,
            serverDraftIds: msg.serverDraftIds,
            importKnownHosts: msg.importKnownHosts,
            keyPaths: msg.keyPaths,
            passphrases: msg.passphrases,
          }),
        (result) =>
          emit({ type: "ssh.import.apply.response", payload: { requestId, error: null, result } }),
        (error) =>
          emit({ type: "ssh.import.apply.response", payload: { requestId, error, result: null } }),
      );
    case "ssh.keys.install_to_server.request":
      return respond(
        () =>
          keys.install(msg.serverId, msg.keyId, {
            directory: msg.directory ?? ".ssh",
            filename: msg.filename ?? "authorized_keys",
          }),
        ({ outcome, path }) =>
          emit({
            type: "ssh.keys.install_to_server.response",
            payload: { requestId, error: null, outcome, path },
          }),
        (error) =>
          emit({
            type: "ssh.keys.install_to_server.response",
            payload: { requestId, error, outcome: null, path: null },
          }),
      );
  }
}
