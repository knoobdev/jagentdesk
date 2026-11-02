import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SshWorkspaceLayout } from "@jagentdesk/protocol/ssh/snippets-schemas";
import { CommandLineTracker } from "./command-line.js";
import { CommandHistory, HISTORY_LIMIT_PER_SERVER } from "./history.js";
import { SnippetLibrary, SnippetNotFoundError, SnippetValidationError } from "./library.js";
import { WorkspaceLayoutError, WorkspaceTemplates, validateWorkspaceLayout } from "./workspaces.js";

let sshHome: string;
let clock: number;
const now = () => clock;

beforeEach(async () => {
  sshHome = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "jad-ssh-snippets-")), "ssh");
  clock = 1_700_000_000_000;
});

afterEach(async () => {
  await fs.rm(path.dirname(sshHome), { recursive: true, force: true });
});

async function modeOf(target: string): Promise<number> {
  return (await fs.stat(target)).mode & 0o777;
}

describe("SnippetLibrary", () => {
  it("creates, updates and lists snippets with packages in a 0600 file", async () => {
    const library = new SnippetLibrary(sshHome, now);
    const pkg = await library.savePackage({ label: "Deploy" });
    const created = await library.save({
      label: "Kernel",
      script: "uname -a",
      packageId: pkg.id,
      defaultTargets: ["srv_a", "srv_a", "srv_b"],
    });
    clock += 1000;
    const updated = await library.save({ ...created, script: "uname -r" });

    expect(created.id).toMatch(/^snp_[0-9a-f]{12}$/);
    expect(updated).toEqual({
      id: created.id,
      label: "Kernel",
      script: "uname -r",
      packageId: pkg.id,
      defaultTargets: ["srv_a", "srv_b"],
      createdAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_001_000,
    });
    expect(await library.list()).toEqual({ packages: [pkg], snippets: [updated] });
    expect(await modeOf(path.join(sshHome, "snippets.json"))).toBe(0o600);
    expect(await modeOf(sshHome)).toBe(0o700);
  });

  it("rejects an empty script, an unknown package and an unknown id", async () => {
    const library = new SnippetLibrary(sshHome, now);
    await expect(library.save({ label: "x", script: "  ", defaultTargets: [] })).rejects.toThrow(
      SnippetValidationError,
    );
    await expect(
      library.save({ label: "x", script: "ls", packageId: "spk_missing", defaultTargets: [] }),
    ).rejects.toThrow(SnippetNotFoundError);
    await expect(
      library.save({ id: "snp_missing", label: "x", script: "ls", defaultTargets: [] }),
    ).rejects.toThrow(SnippetNotFoundError);
  });

  it("keeps snippets when their package is deleted", async () => {
    const library = new SnippetLibrary(sshHome, now);
    const pkg = await library.savePackage({ label: "Ops" });
    const snippet = await library.save({
      label: "Disk",
      script: "df -h",
      packageId: pkg.id,
      defaultTargets: [],
    });
    await library.deletePackage(pkg.id);
    const { packageId: _gone, ...withoutPackage } = snippet;
    expect(await library.list()).toEqual({ packages: [], snippets: [withoutPackage] });
  });

  it("serializes concurrent saves without losing writes", async () => {
    const library = new SnippetLibrary(sshHome, now);
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        library.save({ label: `s${i}`, script: `echo ${i}`, defaultTargets: [] }),
      ),
    );
    expect((await library.list()).snippets.map((s) => s.label).sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => `s${i}`).sort(),
    );
  });
});

describe("CommandHistory", () => {
  it("keeps per-server history newest first and moves a repeated command to the top", async () => {
    const history = new CommandHistory(sshHome, now);
    await history.record({ serverIds: ["srv_a", "srv_b"], command: "ls", source: "snippet" });
    clock += 1;
    await history.record({ serverIds: ["srv_a"], command: "  pwd ", source: "input" });
    clock += 1;
    await history.record({ serverIds: ["srv_a"], command: "ls", source: "input" });
    await history.record({ serverIds: ["srv_a"], command: "   ", source: "input" });

    expect(await history.list("srv_a")).toEqual([
      { command: "ls", source: "input", atMs: 1_700_000_000_002 },
      { command: "pwd", source: "input", atMs: 1_700_000_000_001 },
    ]);
    expect(await history.list("srv_b")).toEqual([
      { command: "ls", source: "snippet", atMs: 1_700_000_000_000 },
    ]);
    await history.clear("srv_a");
    expect(await history.list("srv_a")).toEqual([]);
    expect(await modeOf(path.join(sshHome, "history.json"))).toBe(0o600);
  });

  it("caps each server's history", async () => {
    const history = new CommandHistory(sshHome, now);
    for (let i = 0; i < HISTORY_LIMIT_PER_SERVER + 5; i += 1) {
      await history.record({ serverIds: ["srv_a"], command: `echo ${i}`, source: "input" });
    }
    const entries = await history.list("srv_a");
    expect(entries).toHaveLength(HISTORY_LIMIT_PER_SERVER);
    expect(entries[0]?.command).toBe(`echo ${HISTORY_LIMIT_PER_SERVER + 4}`);
  });
});

describe("CommandLineTracker", () => {
  it("returns completed commands and applies line editing", () => {
    const tracker = new CommandLineTracker();
    expect(tracker.push("ls -la\r")).toEqual(["ls -la"]);
    expect(tracker.push("gti\x7f\x7f\x7fgit status")).toEqual([]);
    expect(tracker.push("\r")).toEqual(["git status"]);
    expect(tracker.push("rm -rf /tmp/x\x15echo ok\r")).toEqual(["echo ok"]);
    expect(tracker.push("sleep 10\x03")).toEqual([]);
    expect(tracker.push("\r")).toEqual([]);
  });

  it("drops arrow keys, OSC sequences and bracketed paste markers", () => {
    const tracker = new CommandLineTracker();
    expect(tracker.push("\x1b[A\x1bOBdocker ps\x1b]0;title\x07\r")).toEqual(["docker ps"]);
    expect(tracker.push("\x1b[200~uptime\x1b[201~\r")).toEqual(["uptime"]);
  });
});

function pane(id: string, serverId: string): SshWorkspaceLayout["nodes"][number] {
  return { kind: "pane", id, target: { kind: "server", serverId } };
}

describe("validateWorkspaceLayout", () => {
  it("accepts a nested split and rejects malformed trees", () => {
    const valid: SshWorkspaceLayout = {
      rootId: "n1",
      nodes: [
        { kind: "split", id: "n1", direction: "row", children: ["p1", "n2"], sizes: [0.5, 0.5] },
        {
          kind: "split",
          id: "n2",
          direction: "column",
          children: ["p2", "p3"],
          sizes: [0.3, 0.7],
        },
        pane("p1", "srv_a"),
        pane("p2", "srv_b"),
        { kind: "pane", id: "p3", target: { kind: "local" }, tabTitle: "Local" },
      ],
    };
    expect(() => validateWorkspaceLayout(valid)).not.toThrow();
    expect(() =>
      validateWorkspaceLayout({ ...valid, nodes: [...valid.nodes, pane("p4", "srv_c")] }),
    ).toThrow("unreachable");
    expect(() =>
      validateWorkspaceLayout({
        rootId: "n1",
        nodes: [
          { kind: "split", id: "n1", direction: "row", children: ["p1", "p2"], sizes: [0.5, 0.2] },
          pane("p1", "srv_a"),
          pane("p2", "srv_b"),
        ],
      }),
    ).toThrow("sum to 1");
    expect(() =>
      validateWorkspaceLayout({
        rootId: "n1",
        nodes: [
          { kind: "split", id: "n1", direction: "row", children: ["p1", "p1"], sizes: [0.5, 0.5] },
          pane("p1", "srv_a"),
        ],
      }),
    ).toThrow("appears twice");
  });

  it("allows 16 panes and rejects 17", () => {
    function grid(count: number): SshWorkspaceLayout {
      const ids = Array.from({ length: count }, (_, i) => `p${i}`);
      return {
        rootId: "root",
        nodes: [
          {
            kind: "split",
            id: "root",
            direction: "row",
            children: ids,
            sizes: ids.map(() => 1 / count),
          },
          ...ids.map((id) => pane(id, `srv_${id}`)),
        ],
      };
    }
    expect(() => validateWorkspaceLayout(grid(16))).not.toThrow();
    expect(() => validateWorkspaceLayout(grid(17))).toThrow(WorkspaceLayoutError);
  });
});

describe("WorkspaceTemplates", () => {
  it("saves, reopens and deletes a template", async () => {
    const templates = new WorkspaceTemplates(sshHome, now);
    const layout: SshWorkspaceLayout = {
      rootId: "n1",
      nodes: [
        { kind: "split", id: "n1", direction: "row", children: ["p1", "p2"], sizes: [0.5, 0.5] },
        { ...pane("p1", "srv_a"), tabTitle: "web" },
        pane("p2", "srv_b"),
      ],
    };
    const saved = await templates.save({ label: "Prod pair", layout });
    expect(await new WorkspaceTemplates(sshHome, now).list()).toEqual([
      {
        id: saved.id,
        label: "Prod pair",
        layout,
        createdAtMs: 1_700_000_000_000,
        updatedAtMs: 1_700_000_000_000,
      },
    ]);
    await templates.delete(saved.id);
    expect(await templates.list()).toEqual([]);
  });
});
