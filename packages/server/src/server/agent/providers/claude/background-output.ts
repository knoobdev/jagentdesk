import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, sep } from "node:path";
import type {
  BackgroundWorkOutputFile,
  BackgroundWorkOutputSource,
} from "../../background-work/index.js";
import { isInsideOutputRoots } from "../../background-work/output-stream.js";

/**
 * Claude Code writes the output of every background shell and Monitor task to
 * `<temp>/claude-<uid>/<project>/<session id>/tasks/<task id>.output`, names that file in the
 * Bash tool result ("Output is being written to: <path>.") and again as `output_file` in the
 * task notification. Monitor results do not name it, so it is found by the session and task id.
 */
const OUTPUT_NOTICE = /Output is being written to:? (\/\S+?\.output)(?=[.;,]?(?:\s|$))/;
const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function parseClaudeBackgroundOutputPath(text: string): string | null {
  return OUTPUT_NOTICE.exec(text)?.[1] ?? null;
}

/** Claude's per-user temp folders this daemon accepts output files from. */
export function claudeTaskOutputRoots(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const bases = [env.CLAUDE_CODE_TMPDIR, "/tmp", env.TMPDIR, tmpdir()].filter(
    (base): base is string => typeof base === "string" && isAbsolute(base),
  );
  return [...new Set(bases.map((base) => join(base, `claude-${uid}`)))];
}

/** The path names this task's own output file in a `tasks` folder, with nothing relative. */
export function isClaudeTaskOutputPath(path: string, taskId: string): boolean {
  return (
    TASK_ID.test(taskId) &&
    isAbsolute(path) &&
    normalize(path) === path &&
    path.endsWith(`${sep}tasks${sep}${taskId}.output`)
  );
}

interface ClaudeOutputSourceInput {
  taskId: string;
  /** The path Claude reported for this task, if it has. */
  reportedPath(): string | null;
  sessionId(): string | null;
  roots: readonly string[];
}

export function createClaudeOutputSource(
  input: ClaudeOutputSourceInput,
): BackgroundWorkOutputSource {
  return { type: "file", locate: () => locateClaudeOutput(input) };
}

async function locateClaudeOutput({
  taskId,
  reportedPath,
  sessionId,
  roots,
}: ClaudeOutputSourceInput): Promise<BackgroundWorkOutputFile | null> {
  if (!TASK_ID.test(taskId)) return null;
  const reported = reportedPath();
  if (reported && isClaudeTaskOutputPath(reported, taskId)) {
    const file = { path: reported, roots };
    if (await isInsideOutputRoots(file)) return file;
  }
  const session = sessionId();
  if (!session || !TASK_ID.test(session)) return null;
  for (const root of roots) {
    const projects = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const file = {
        path: join(root, project.name, session, "tasks", `${taskId}.output`),
        roots,
      };
      if (await isInsideOutputRoots(file)) return file;
    }
  }
  return null;
}
