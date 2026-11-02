import type { FileVersion, FileWriteResult } from "@jagentdesk/protocol/messages";
import type {
  SftpEndpoint,
  SftpFileVersion,
  SftpOpenedFile,
} from "@jagentdesk/protocol/ssh/sftp-schemas";
import type {
  FileEditorFile,
  FileEditorObservation,
  FileEditorSession,
  FileObservationSource,
} from "@/file-pane/editor/model";
import { SshModuleRpcError } from "../module-rpc";
import type { SftpApi } from "./api";
import { endpointKey } from "./model";

// Adapters that let the existing code editor (FileEditorModel + FileEditorView) edit a file over
// SFTP: saves go to ssh.sftp.write with the revision the editor opened, so a file changed on the
// server since then comes back as a conflict and the editor offers Overwrite / Reload.

const BOM = "﻿";

export interface SftpEditorTarget {
  api: SftpApi;
  endpoint: SftpEndpoint;
  path: string;
}

/** Stable `cwd` for FileVersion records of an SFTP file (the editor only compares it). */
export function editorCwd(endpoint: SftpEndpoint): string {
  return `sftp:${endpointKey(endpoint)}`;
}

function toReadyVersion(
  endpoint: SftpEndpoint,
  version: SftpFileVersion,
): Extract<FileVersion, { status: "ready" }> {
  return {
    status: "ready",
    cwd: editorCwd(endpoint),
    path: version.path,
    size: version.size,
    modifiedAt: new Date(version.modifiedAtMs).toISOString(),
    revision: version.revision,
  };
}

export function toEditorFile(endpoint: SftpEndpoint, opened: SftpOpenedFile): FileEditorFile {
  return {
    content: opened.content,
    hasBom: opened.hasBom,
    version: toReadyVersion(endpoint, opened.version),
  };
}

export function createSftpEditorSession(target: SftpEditorTarget): FileEditorSession {
  return {
    async write(input) {
      const hasBom = input.content.startsWith(BOM);
      const content = hasBom ? input.content.slice(BOM.length) : input.content;
      let result;
      try {
        result = await target.api.write({
          endpoint: target.endpoint,
          path: target.path,
          content,
          hasBom,
          ...(input.expectedRevision ? { expectedRevision: input.expectedRevision } : {}),
        });
      } catch (error) {
        if (error instanceof SshModuleRpcError) {
          return { status: "error", error: error.message } satisfies FileWriteResult;
        }
        throw error;
      }
      if (result.status === "conflict") {
        const version: FileVersion = result.current
          ? toReadyVersion(target.endpoint, result.current)
          : { status: "missing", cwd: editorCwd(target.endpoint), path: target.path };
        return { status: "conflict", version } satisfies FileWriteResult;
      }
      const written = toReadyVersion(target.endpoint, result.version);
      return {
        status: "written",
        modifiedAt: written.modifiedAt,
        size: written.size,
        revision: written.revision,
      } satisfies FileWriteResult;
    },
  };
}

/** Observation source that re-reads the file over SFTP when the editor asks to reload. */
export function createSftpObservationSource(
  target: SftpEditorTarget,
  opened: SftpOpenedFile,
): FileObservationSource {
  let observation: FileEditorObservation = {
    status: "ready",
    file: toEditorFile(target.endpoint, opened),
  };
  const listeners = new Set<() => void>();
  function publish(next: FileEditorObservation): void {
    observation = next;
    for (const listener of listeners) listener();
  }
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getObservation: () => observation,
    refresh() {
      target.api.read(target.endpoint, target.path).then(
        (file) => publish({ status: "ready", file: toEditorFile(target.endpoint, file) }),
        (error: unknown) => {
          const cwd = editorCwd(target.endpoint);
          if (error instanceof SshModuleRpcError && error.code === "not_found") {
            publish({ status: "missing", cwd, path: target.path });
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          publish({ status: "error", cwd, path: target.path, error: message });
        },
      );
    },
  };
}
