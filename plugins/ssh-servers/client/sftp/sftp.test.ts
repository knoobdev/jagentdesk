import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SshTransfer } from "@jagentdesk/protocol/ssh/sftp-schemas";
import { FileEditorModel } from "@/file-pane/editor/model";
import type { SshModuleTransport } from "../module-rpc";
import { createSftpApi } from "./api";
import {
  createSftpEditorSession,
  createSftpObservationSource,
  toEditorFile,
} from "./editor-session";
import {
  applyTransfer,
  basename,
  formatBytes,
  invalidNameReason,
  joinEndpointPath,
  octalMode,
  transferActions,
} from "./model";
import { createTransferStore } from "./transfer-store";

const endpoint = { kind: "server", serverId: "srv_a1b2c3" } as const;

function transfer(overrides: Partial<SshTransfer>): SshTransfer {
  return {
    id: "xfr_1",
    source: endpoint,
    sourcePath: "/var/log/app.log",
    target: { kind: "daemon" },
    targetPath: "/home/user/app.log",
    kind: "file",
    status: "running",
    bytesTotal: 100,
    bytesTransferred: 10,
    filesTotal: 1,
    filesDone: 0,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...overrides,
  };
}

function sha(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// A daemon stand-in for one remote file, answering the same wire messages the real daemon does.
function createFileTransport(initial: string) {
  let content = initial;
  let modifiedAtMs = 1_000;
  const pushHandlers = new Map<string, Set<(message: unknown) => void>>();
  const version = () => ({
    path: "/etc/app.conf",
    size: Buffer.byteLength(content),
    modifiedAtMs,
    revision: sha(content),
  });
  const transport: SshModuleTransport = {
    async request(message) {
      const requestId = "req";
      if (message.type === "ssh.sftp.read.request") {
        return {
          type: "ssh.sftp.read.response",
          payload: { requestId, error: null, file: { content, hasBom: false, version: version() } },
        };
      }
      if (message.type === "ssh.sftp.write.request") {
        if (message.expectedRevision && message.expectedRevision !== sha(content)) {
          return {
            type: "ssh.sftp.write.response",
            payload: { requestId, error: null, result: { status: "conflict", current: version() } },
          };
        }
        content = String(message.content);
        modifiedAtMs += 1_000;
        return {
          type: "ssh.sftp.write.response",
          payload: { requestId, error: null, result: { status: "written", version: version() } },
        };
      }
      if (message.type === "ssh.transfer.list.request") {
        return {
          type: "ssh.transfer.list.response",
          payload: { requestId, error: null, transfers: [transfer({ updatedAtMs: 1 })] },
        };
      }
      return {
        type: message.type.replace(/\.request$/, ".response"),
        payload: { requestId, error: { code: "not_found", message: "missing" } },
      };
    },
    subscribe(type, handler) {
      const handlers = pushHandlers.get(type) ?? new Set();
      handlers.add(handler);
      pushHandlers.set(type, handlers);
      return () => handlers.delete(handler);
    },
  };
  return {
    transport,
    changeOnServer(next: string) {
      content = next;
      modifiedAtMs += 1_000;
    },
    serverContent: () => content,
    push(type: string, message: unknown) {
      for (const handler of pushHandlers.get(type) ?? []) handler(message);
    },
  };
}

describe("sftp model helpers", () => {
  it("formats sizes and modes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(104857600)).toBe("100 MB");
    expect(octalMode(0o40755)).toBe("755");
  });

  it("joins paths in the endpoint's own flavour", () => {
    expect(joinEndpointPath("/srv/www", "index.html")).toBe("/srv/www/index.html");
    expect(joinEndpointPath("/", "etc")).toBe("/etc");
    expect(joinEndpointPath("C:\\Users\\dev", "notes.txt")).toBe("C:\\Users\\dev\\notes.txt");
    expect(basename("/srv/www/")).toBe("www");
  });

  it("rejects names that would escape the folder", () => {
    expect(invalidNameReason("a/b")).toBe("separator");
    expect(invalidNameReason("..")).toBe("empty");
    expect(invalidNameReason("logs")).toBeNull();
  });

  it("offers conflict resolutions only for a transfer in conflict", () => {
    expect(transferActions(transfer({ status: "conflict" }))).toEqual([
      { kind: "resolve", policy: "replace" },
      { kind: "resolve", policy: "keep-both" },
      { kind: "resolve", policy: "skip" },
      { kind: "cancel" },
    ]);
    expect(transferActions(transfer({ status: "paused" }))).toEqual([
      { kind: "resume" },
      { kind: "cancel" },
    ]);
    expect(transferActions(transfer({ status: "failed" }))).toEqual([
      { kind: "retry" },
      { kind: "dismiss" },
    ]);
  });

  it("keeps the newest pushed state of a transfer", () => {
    const list = [transfer({ updatedAtMs: 5, bytesTransferred: 50 })];
    expect(applyTransfer(list, transfer({ updatedAtMs: 4, bytesTransferred: 40 }))).toBe(list);
    expect(
      applyTransfer(list, transfer({ updatedAtMs: 6, bytesTransferred: 60 }))[0],
    ).toMatchObject({ bytesTransferred: 60 });
  });
});

describe("transfer store", () => {
  it("merges progress pushed while the list loads", async () => {
    const daemon = createFileTransport("");
    const store = createTransferStore(createSftpApi(daemon.transport));
    const ready = new Promise<void>((resolve) =>
      store.subscribe(() => {
        if (store.getSnapshot().status === "ready") resolve();
      }),
    );
    const stop = store.start();
    daemon.push("ssh.transfer.progress", {
      type: "ssh.transfer.progress",
      transfer: transfer({ updatedAtMs: 9, bytesTransferred: 90 }),
    });
    await ready;

    expect(store.getSnapshot()).toEqual({
      status: "ready",
      error: null,
      transfers: [transfer({ updatedAtMs: 9, bytesTransferred: 90 })],
    });
    stop();
  });
});

describe("SFTP editor session", () => {
  it("saves through ssh.sftp.write and surfaces a server-side change as a conflict", async () => {
    const daemon = createFileTransport("port=80\n");
    const api = createSftpApi(daemon.transport);
    const target = { api, endpoint, path: "/etc/app.conf" };
    const opened = await api.read(endpoint, "/etc/app.conf");
    const model = new FileEditorModel({
      file: toEditorFile(endpoint, opened),
      session: createSftpEditorSession(target),
    });
    model.connectFileObservations(createSftpObservationSource(target, opened));

    model.edit("port=8080\n");
    await model.save();
    expect(daemon.serverContent()).toBe("port=8080\n");
    expect(model.getSnapshot().status).toBe("clean");

    daemon.changeOnServer("port=9090\n");
    model.edit("port=1\n");
    await model.save();
    expect(model.getSnapshot().status).toBe("conflict");
    expect(daemon.serverContent()).toBe("port=9090\n");

    await model.overwrite();
    expect(daemon.serverContent()).toBe("port=1\n");
    expect(model.getSnapshot().status).toBe("clean");
    model.dispose();
  });
});
