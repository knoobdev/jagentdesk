import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { AgentTimelineRow } from "../agent-timeline-store-types.js";
import {
  allowedRoots,
  describeRedirect,
  findLastReads,
  isBlockedSecretPath,
  planExtraSources,
  readScript,
  redirectOutputSource,
  SCRIPT_MAX_BYTES,
  systemTempRoots,
} from "./extra-sources.js";
import { followBackgroundWorkOutput, type BackgroundWorkOutputChunk } from "./output-stream.js";

function joinChunks(chunks: readonly BackgroundWorkOutputChunk[]): string {
  return chunks.map((chunk) => chunk.chunk).join("");
}

// ADR-0064 §1–§2: which redirect files and scripts may be read.
describe("path rules", () => {
  const env = { TMPDIR: "/var/folders/ab/cd/T/" };

  test("allows the agent's folder and the system temp folders", () => {
    const roots = (path: string) => allowedRoots(path, "/repo", systemTempRoots(env, path));
    expect(roots("/tmp/t.log")).not.toBeNull();
    expect(roots("/private/tmp/t.log")).not.toBeNull();
    expect(roots("/var/folders/ab/cd/T/x.log")).not.toBeNull();
    expect(
      allowedRoots(
        "/var/folders/zz/yy/T/x.log",
        "/repo",
        systemTempRoots({}, "/var/folders/zz/yy/T/x.log"),
      ),
    ).not.toBeNull();
    expect(roots("/repo/logs/t.log")).not.toBeNull();
    expect(roots("/var/folders/zz/yy/x.log")).toBeNull();
  });

  test("refuses everything else", () => {
    expect(allowedRoots("/etc/passwd", "/repo", systemTempRoots(env, "/etc/passwd"))).toBeNull();
    expect(allowedRoots("/dev/null", "/repo", systemTempRoots(env, "/dev/null"))).toBeNull();
    expect(allowedRoots("/dev/stdout", "/repo", systemTempRoots(env, "/dev/stdout"))).toBeNull();
    expect(allowedRoots("/repo2/t.log", "/repo", systemTempRoots(env, "/repo2/t.log"))).toBeNull();
    expect(
      allowedRoots("/Users/me/t.log", "/repo", systemTempRoots(env, "/Users/me/t.log")),
    ).toBeNull();
    expect(
      allowedRoots("/tmp/../etc/passwd", "/repo", systemTempRoots(env, "/tmp/../etc/passwd")),
    ).toBeNull();
    expect(allowedRoots("relative.log", "/repo", systemTempRoots(env, "relative.log"))).toBeNull();
    // An agent rooted at "/" does not open the whole disk.
    expect(allowedRoots("/etc/passwd", "/", systemTempRoots(env))).toBeNull();
  });

  test.each([
    "/repo/.env",
    "/repo/.env.local",
    "/repo/.envrc",
    "/tmp/server.pem",
    "/tmp/tls.key",
    "/tmp/id_rsa",
    "/tmp/id_ed25519.pub",
    "/home/me/.ssh/x",
    "/repo/.aws/credentials",
    "/home/me/.config/gh/hosts.yml",
    "/home/me/Library/Keychains/login.keychain-db",
    "/tmp/backup.keychain",
    "/home/me/.gnupg/pubring.kbx",
    "/home/me/.netrc",
  ])("blocks the secret %s", (path) => {
    expect(isBlockedSecretPath(path)).toBe(true);
    expect(allowedRoots(path, "/home/me", systemTempRoots(env, path))).toBeNull();
  });

  test.each(["/tmp/t.log", "/repo/environment.md", "/repo/keys.ts", "/repo/src/identity.ts"])(
    "lets %s through",
    (path) => {
      expect(isBlockedSecretPath(path)).toBe(false);
    },
  );

  test("plans only allowed targets, with ids that follow the command", () => {
    const plan = planExtraSources({
      command: "npm test > ~/.ssh/x 2> /tmp/err.log | tee logs/t.log > /dev/null",
      workCwd: null,
      agentCwd: "/repo",
      home: "/home/me",
      env,
    });
    expect(plan.redirects.map(({ id, label, path }) => ({ id, label, path }))).toEqual([
      { id: "redirect:1", label: "err.log", path: "/tmp/err.log" },
      { id: "redirect:3", label: "t.log", path: "/repo/logs/t.log" },
    ]);
  });

  test("relative paths start in the work's own folder", () => {
    const plan = planExtraSources({
      command: "zsh wait.sh > out.log",
      workCwd: "/repo/sub",
      agentCwd: "/repo",
      env,
    });
    expect(plan.redirects.map((redirect) => redirect.path)).toEqual(["/repo/sub/out.log"]);
    expect(plan.script?.path).toBe("/repo/sub/wait.sh");
  });

  test("a script outside the allowed folders is not planned", () => {
    expect(
      planExtraSources({ command: "bash /etc/profile", workCwd: null, agentCwd: "/repo", env })
        .script,
    ).toBeNull();
  });
});

describe("files on disk", () => {
  let root: string;
  let agentCwd: string;
  let outside: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "bg-sources-")));
    agentCwd = join(root, "repo");
    mkdirSync(agentCwd);
    // A folder outside every allowed root: the agent folder is `repo` and the plan below has
    // no temp roots. The `home` folder plays the user's home.
    outside = join(root, "home");
    mkdirSync(join(outside, ".ssh"), { recursive: true });
    writeFileSync(join(outside, ".ssh", "id_rsa"), "PRIVATE KEY");
    writeFileSync(join(outside, "notes.txt"), "outside");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function plan(command: string) {
    return planExtraSources({ command, workCwd: null, agentCwd, home: outside, tempRoots: [] });
  }

  test("a regular file in the agent's folder is described", async () => {
    writeFileSync(join(agentCwd, "t.log"), "hello\n");
    const [redirect] = plan("npm test > t.log 2>&1").redirects;
    expect(await describeRedirect(redirect)).toEqual({
      exists: true,
      size: 6,
      modifiedAt: expect.any(String),
    });
  });

  test("a file not created yet is waited for", async () => {
    const [redirect] = plan("npm test > later.log").redirects;
    expect(await describeRedirect(redirect)).toEqual({
      exists: false,
      size: 0,
      modifiedAt: null,
    });
  });

  test("a symlink out to a secret is refused", async () => {
    symlinkSync(join(outside, ".ssh", "id_rsa"), join(agentCwd, "l"));
    const [redirect] = plan("cmd > l").redirects;
    expect(redirect.path).toBe(join(agentCwd, "l"));
    expect(await describeRedirect(redirect)).toBeNull();
    const chunks: BackgroundWorkOutputChunk[] = [];
    await expect(
      followBackgroundWorkOutput({
        source: redirectOutputSource(redirect, () => true),
        onChunk: (chunk) => chunks.push(chunk),
        onError: () => undefined,
      }),
    ).rejects.toThrow();
    expect(chunks).toEqual([]);
  });

  test("a folder symlink that leads outside is refused", async () => {
    symlinkSync(outside, join(agentCwd, "out"));
    const [redirect] = plan("cmd > out/notes.txt").redirects;
    expect(await describeRedirect(redirect)).toBeNull();
    await expect(
      followBackgroundWorkOutput({
        source: redirectOutputSource(redirect, () => true),
        onChunk: () => undefined,
        onError: () => undefined,
      }),
    ).rejects.toThrow();
  });

  test("~/.ssh targets are never planned", () => {
    expect(plan("cmd > ~/.ssh/x").redirects).toEqual([]);
    expect(plan("cmd > ~/notes.txt").redirects).toEqual([]);
  });

  test("a FIFO is refused without blocking", async () => {
    const fifo = join(agentCwd, "pipe.log");
    execFileSync("mkfifo", [fifo]);
    const [redirect] = plan("cmd > pipe.log").redirects;
    expect(await describeRedirect(redirect)).toBeNull();
    await expect(
      followBackgroundWorkOutput({
        source: redirectOutputSource(redirect, () => true),
        onChunk: () => undefined,
        onError: () => undefined,
      }),
    ).rejects.toThrow();
  });

  test("a folder is refused", async () => {
    mkdirSync(join(agentCwd, "dir.log"));
    const [redirect] = plan("cmd > dir.log").redirects;
    expect(await describeRedirect(redirect)).toBeNull();
  });

  test("waits for the file while the work runs, then follows it", async () => {
    const [redirect] = plan("npm test > t.log 2>&1").redirects;
    const chunks: BackgroundWorkOutputChunk[] = [];
    const stop = await followBackgroundWorkOutput({
      source: redirectOutputSource(redirect, () => true),
      onChunk: (chunk) => chunks.push(chunk),
      onError: (error) => {
        throw error;
      },
      pollMs: 50,
    });
    try {
      expect(chunks).toEqual([{ chunk: "", offset: 0, nextOffset: 0, reset: true }]);
      writeFileSync(join(agentCwd, "t.log"), "line-1\n");
      await expect.poll(() => joinChunks(chunks)).toBe("line-1\n");
      appendFileSync(join(agentCwd, "t.log"), "line-2\n");
      await expect.poll(() => joinChunks(chunks)).toBe("line-1\nline-2\n");
    } finally {
      stop();
    }
  });

  test("a missing file of ended work is not available", async () => {
    const [redirect] = plan("npm test > never.log").redirects;
    await expect(
      followBackgroundWorkOutput({
        source: redirectOutputSource(redirect, () => false),
        onChunk: () => undefined,
        onError: () => undefined,
      }),
    ).rejects.toThrow("Output is not available");
  });

  test("a waited-for file that turns out to be a symlink out is refused", async () => {
    const [redirect] = plan("cmd > late.log").redirects;
    const errors: Error[] = [];
    const chunks: BackgroundWorkOutputChunk[] = [];
    const stop = await followBackgroundWorkOutput({
      source: redirectOutputSource(redirect, () => true),
      onChunk: (chunk) => chunks.push(chunk),
      onError: (error) => errors.push(error),
      pollMs: 50,
    });
    try {
      symlinkSync(join(outside, ".ssh", "id_rsa"), join(agentCwd, "late.log"));
      await expect.poll(() => errors.length).toBe(1);
      expect(joinChunks(chunks)).toBe("");
    } finally {
      stop();
    }
  });

  test("reads the script, up to 64 KiB", async () => {
    writeFileSync(join(agentCwd, "wait.sh"), "#!/bin/zsh\nwhile true; do\n  sleep 1\ndone\n");
    const script = plan("zsh wait.sh").script;
    expect(script).not.toBeNull();
    expect(await readScript(script!)).toEqual({
      path: join(agentCwd, "wait.sh"),
      label: "wait.sh",
      content: "#!/bin/zsh\nwhile true; do\n  sleep 1\ndone\n",
      truncated: false,
      lineCount: 4,
    });

    writeFileSync(join(agentCwd, "big.sh"), "echo x\n".repeat(SCRIPT_MAX_BYTES / 7 + 10));
    const big = await readScript(plan("bash big.sh").script!);
    expect(big?.truncated).toBe(true);
    expect(big?.content.length).toBe(SCRIPT_MAX_BYTES);
  });

  test("a binary, a symlinked or a missing script is not shown", async () => {
    writeFileSync(join(agentCwd, "tool"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2]));
    expect(await readScript(plan("./tool").script!)).toBeNull();
    symlinkSync(join(outside, "notes.txt"), join(agentCwd, "linked.sh"));
    expect(await readScript(plan("sh linked.sh").script!)).toBeNull();
    expect(await readScript(plan("sh missing.sh").script!)).toBeNull();
  });
});

// ADR-0064 §3: the agent's latest read of a redirect file, from its own timeline.
describe("last read by the agent", () => {
  const redirects = planExtraSources({
    command: "npm test > /tmp/t.log 2>&1",
    workCwd: null,
    agentCwd: "/repo",
  }).redirects;

  function row(seq: number, timestamp: string, item: AgentTimelineRow["item"]): AgentTimelineRow {
    return { seq, timestamp, item };
  }

  function shell(command: string, output: string): AgentTimelineRow["item"] {
    return {
      type: "tool_call",
      callId: `c-${command}`,
      name: "Bash",
      status: "completed",
      error: null,
      detail: { type: "shell", command, output },
    };
  }

  test("takes the latest cat/tail/head or read-file call after the work started", () => {
    const rows = [
      row(1, "2026-11-28T10:00:00.000Z", shell("tail /tmp/t.log", "before start")),
      row(2, "2026-11-28T10:01:00.000Z", shell("tail -n 5 /tmp/t.log", "PASS 1")),
      row(3, "2026-11-28T10:02:00.000Z", shell("grep x /tmp/t.log", "not a read")),
      row(4, "2026-11-28T10:03:00.000Z", {
        type: "tool_call",
        callId: "r1",
        name: "Read",
        status: "completed",
        error: null,
        detail: { type: "read", filePath: "/tmp/t.log", content: "PASS 1\nPASS 2" },
      }),
      row(5, "2026-11-28T10:04:00.000Z", shell("cat /tmp/other.log", "other")),
    ];
    const reads = findLastReads({
      rows,
      startedAt: "2026-11-28T10:00:30.000Z",
      redirects,
      agentCwd: "/repo",
    });
    expect([...reads]).toEqual([
      [
        "redirect:0",
        { at: "2026-11-28T10:03:00.000Z", content: "PASS 1\nPASS 2", truncated: false },
      ],
    ]);
  });

  test("a running read has nothing to show yet", () => {
    const reads = findLastReads({
      rows: [
        row(1, "2026-11-28T10:01:00.000Z", {
          type: "tool_call",
          callId: "c1",
          name: "Bash",
          status: "running",
          error: null,
          detail: { type: "shell", command: "tail /tmp/t.log" },
        }),
      ],
      startedAt: "2026-11-28T10:00:00.000Z",
      redirects,
      agentCwd: "/repo",
    });
    expect(reads.size).toBe(0);
  });
});
