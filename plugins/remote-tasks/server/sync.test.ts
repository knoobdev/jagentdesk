import { describe, expect, it } from "vitest";
import type { SnapshotEntry, WorkspaceSnapshot } from "./snapshot.js";
import {
  diffManifest,
  emptyRemoteManifest,
  isSafeRelativeDeletePath,
  parseRemoteManifest,
} from "./sync.js";

function entry(path: string, hash: string, overrides?: Partial<SnapshotEntry>): SnapshotEntry {
  return {
    path,
    mode: 0o644,
    symlink: false,
    executable: false,
    hash,
    size: 10,
    ...overrides,
  };
}

function snapshotWith(files: SnapshotEntry[]): WorkspaceSnapshot {
  return {
    workspacePath: "/ws",
    workspaceKey: "wsk_1",
    snapshotId: "snp_1",
    files,
    bytesTotal: files.reduce((sum, file) => sum + file.size, 0),
    excludedSecrets: [],
    skipped: [],
  };
}

describe("parseRemoteManifest", () => {
  it("parses a valid manifest", () => {
    const parsed = parseRemoteManifest(
      JSON.stringify({
        snapshotId: "snp_9",
        entries: { "a.txt": { hash: "h1", executable: true, symlink: false } },
      }),
    );
    expect(parsed.snapshotId).toBe("snp_9");
    expect(parsed.entries["a.txt"]).toEqual({ hash: "h1", executable: true, symlink: false });
  });

  it("treats missing and invalid manifests as empty", () => {
    expect(parseRemoteManifest("")).toEqual(emptyRemoteManifest());
    expect(parseRemoteManifest("not json")).toEqual(emptyRemoteManifest());
    expect(parseRemoteManifest(JSON.stringify({ entries: { "a.txt": { hash: 1 } } }))).toEqual(
      emptyRemoteManifest(),
    );
    expect(parseRemoteManifest(JSON.stringify({ snapshotId: "snp_9" }))).toEqual(
      emptyRemoteManifest(),
    );
  });
});

describe("diffManifest", () => {
  it("uploads new and changed entries, deletes removed ones, keeps unchanged", () => {
    const oldManifest = {
      snapshotId: "snp_0",
      entries: {
        "same.txt": { hash: "h_same", executable: false, symlink: false },
        "changed.txt": { hash: "h_old", executable: false, symlink: false },
        "gone.txt": { hash: "h_gone", executable: false, symlink: false },
        "../escape.txt": { hash: "h_e", executable: false, symlink: false },
      },
    };
    const snapshot = snapshotWith([
      entry("same.txt", "h_same"),
      entry("changed.txt", "h_new"),
      entry("added.txt", "h_added"),
    ]);
    const diff = diffManifest(oldManifest, snapshot);
    expect(diff.upload.map((file) => file.path).toSorted()).toEqual(["added.txt", "changed.txt"]);
    expect(diff.deletePaths).toEqual(["gone.txt", "../escape.txt"]);
  });

  it("re-uploads when only the exec bit or symlink-ness changes", () => {
    const oldManifest = {
      snapshotId: null,
      entries: {
        "tool.sh": { hash: "h1", executable: false, symlink: false },
        link: { hash: "h2", executable: false, symlink: false },
      },
    };
    const snapshot = snapshotWith([
      entry("tool.sh", "h1", { executable: true, mode: 0o755 }),
      entry("link", "h2", { symlink: true }),
    ]);
    const diff = diffManifest(oldManifest, snapshot);
    expect(diff.upload.map((file) => file.path).toSorted()).toEqual(["link", "tool.sh"]);
  });
});

describe("isSafeRelativeDeletePath", () => {
  it("allows plain relative paths only", () => {
    expect(isSafeRelativeDeletePath("a/b.txt")).toBe(true);
    expect(isSafeRelativeDeletePath("a.txt")).toBe(true);
    expect(isSafeRelativeDeletePath("")).toBe(false);
    expect(isSafeRelativeDeletePath("/etc/passwd")).toBe(false);
    expect(isSafeRelativeDeletePath("../escape")).toBe(false);
    expect(isSafeRelativeDeletePath("a/../../b")).toBe(false);
  });
});
