import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  claudeTaskOutputRoots,
  createClaudeOutputSource,
  isClaudeTaskOutputPath,
  parseClaudeBackgroundOutputPath,
} from "./background-output.js";

describe("parseClaudeBackgroundOutputPath", () => {
  test("reads the path from the Bash results Claude Code writes", () => {
    const path = "/private/tmp/claude-501/-repo/1d2e/tasks/b02mxoehm.output";
    for (const text of [
      `Command running in background with ID: b02mxoehm. Output is being written to: ${path}. You will be notified when it completes.`,
      `Command was manually backgrounded by user with ID: b02mxoehm. Output is being written to: ${path}.`,
      `Command did not complete within its 120s timeout and was moved to the background (ID: b02mxoehm). Output is being written to: ${path}. To check interim output, use Read on that file path.`,
      ` Output is being written to ${path}; use Read on that path for interim output.`,
    ])
      expect(parseClaudeBackgroundOutputPath(text)).toBe(path);
  });

  test("ignores results without an output file", () => {
    expect(parseClaudeBackgroundOutputPath("line-1\nline-2")).toBeNull();
    expect(
      parseClaudeBackgroundOutputPath("Output is being written to: relative.output."),
    ).toBeNull();
  });
});

describe("isClaudeTaskOutputPath", () => {
  test("accepts only this task's file in a tasks folder", () => {
    expect(isClaudeTaskOutputPath("/tmp/claude-1/p/s/tasks/b1.output", "b1")).toBe(true);
    expect(isClaudeTaskOutputPath("/tmp/claude-1/p/s/tasks/b2.output", "b1")).toBe(false);
    expect(isClaudeTaskOutputPath("/tmp/claude-1/p/s/other/b1.output", "b1")).toBe(false);
    expect(isClaudeTaskOutputPath("/tmp/claude-1/p/../../etc/tasks/b1.output", "b1")).toBe(false);
    expect(isClaudeTaskOutputPath("/tmp/claude-1/p/s/tasks/../b1.output", "b1")).toBe(false);
    expect(isClaudeTaskOutputPath("/tmp/x/tasks/a/../b1.output", "../b1")).toBe(false);
  });
});

test("claudeTaskOutputRoots includes Claude's per-user folder under /tmp and CLAUDE_CODE_TMPDIR", () => {
  const roots = claudeTaskOutputRoots({ CLAUDE_CODE_TMPDIR: "/scratch" });
  const uid = process.getuid?.() ?? 0;
  expect(roots).toContain(`/scratch/claude-${uid}`);
  expect(roots).toContain(`/tmp/claude-${uid}`);
});

describe("createClaudeOutputSource", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "claude-output-root-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function taskFile(project: string, session: string, task: string): string {
    mkdirSync(join(root, project, session, "tasks"), { recursive: true });
    const path = join(root, project, session, "tasks", `${task}.output`);
    writeFileSync(path, "out\n");
    return path;
  }

  test("uses the reported path when it is this task's file under the root", async () => {
    const path = taskFile("-repo", "s1", "b1");
    const source = createClaudeOutputSource({
      taskId: "b1",
      reportedPath: () => path,
      sessionId: () => null,
      roots: [root],
    });
    expect(source.type).toBe("file");
    if (source.type !== "file") return;
    expect(await source.locate()).toEqual({ path, roots: [root] });
  });

  test("finds a Monitor task's file by session and task id", async () => {
    const path = taskFile("-repo", "11111111-2222", "bmon1");
    const source = createClaudeOutputSource({
      taskId: "bmon1",
      reportedPath: () => null,
      sessionId: () => "11111111-2222",
      roots: [root],
    });
    if (source.type !== "file") throw new Error("expected a file source");
    expect((await source.locate())?.path).toBe(path);
  });

  test("refuses a reported path outside the root or for another task", async () => {
    const outside = mkdtempSync(join(tmpdir(), "claude-output-outside-"));
    try {
      mkdirSync(join(outside, "tasks"));
      writeFileSync(join(outside, "tasks", "b1.output"), "secret");
      const other = taskFile("-repo", "s1", "b2");
      for (const reported of [join(outside, "tasks", "b1.output"), other, "/etc/passwd"]) {
        const source = createClaudeOutputSource({
          taskId: "b1",
          reportedPath: () => reported,
          sessionId: () => null,
          roots: [root],
        });
        if (source.type !== "file") throw new Error("expected a file source");
        expect(await source.locate()).toBeNull();
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("refuses a task file that is a symlink to somewhere else", async () => {
    mkdirSync(join(root, "-repo", "s1", "tasks"), { recursive: true });
    const link = join(root, "-repo", "s1", "tasks", "b1.output");
    symlinkSync("/etc/hosts", link);
    const source = createClaudeOutputSource({
      taskId: "b1",
      reportedPath: () => link,
      sessionId: () => "s1",
      roots: [root],
    });
    if (source.type !== "file") throw new Error("expected a file source");
    expect(await source.locate()).toBeNull();
  });
});
