import { dumpYaml } from "@kubernetes/client-node";

// Unified diff of a managed resource, the way Argo CD's Diff tab compares normalizedLiveState
// (a) with predictedLiveState (b) as YAML (reference §3.4). Computed in the daemon so the app and
// the agent see the same text.

const CONTEXT_LINES = 3;
// The LCS table is lines(a) × lines(b); beyond this the diff is reported as too large.
const MAX_DIFF_CELLS = 4_000_000;

export function manifestToYaml(manifestJson: string | null | undefined): string {
  if (!manifestJson || manifestJson === "null") return "";
  return dumpYaml(JSON.parse(manifestJson));
}

interface Op {
  kind: " " | "-" | "+";
  line: string;
}

function diffOps(a: string[], b: string[]): Op[] {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const lcs = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * cols + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * cols + j + 1]! + 1
          : Math.max(lcs[(i + 1) * cols + j]!, lcs[i * cols + j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i]! });
      i++;
      j++;
    } else if (lcs[(i + 1) * cols + j]! >= lcs[i * cols + j + 1]!) {
      ops.push({ kind: "-", line: a[i]! });
      i++;
    } else {
      ops.push({ kind: "+", line: b[j]! });
      j++;
    }
  }
  while (i < a.length) ops.push({ kind: "-", line: a[i++]! });
  while (j < b.length) ops.push({ kind: "+", line: b[j++]! });
  return ops;
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.replace(/\n$/, "").split("\n");
}

export interface UnifiedDiff {
  text: string;
  truncated: boolean;
}

export function unifiedDiff(input: {
  before: string;
  after: string;
  label: string;
  maxBytes: number;
}): UnifiedDiff {
  if (input.before === input.after) return { text: "", truncated: false };
  const a = splitLines(input.before);
  const b = splitLines(input.after);
  if ((a.length + 1) * (b.length + 1) > MAX_DIFF_CELLS) {
    return {
      text: `--- live/${input.label}\n+++ desired/${input.label}\n(diff too large)\n`,
      truncated: true,
    };
  }
  const ops = diffOps(a, b);
  const lines = [`--- live/${input.label}`, `+++ desired/${input.label}`];
  let index = 0;
  let oldLine = 1;
  let newLine = 1;
  while (index < ops.length) {
    if (ops[index]!.kind === " ") {
      oldLine++;
      newLine++;
      index++;
      continue;
    }
    const start = Math.max(0, index - CONTEXT_LINES);
    let end = index;
    let lastChange = index;
    while (end < ops.length && end - lastChange <= CONTEXT_LINES * 2) {
      if (ops[end]!.kind !== " ") lastChange = end;
      end++;
    }
    end = Math.min(ops.length, lastChange + CONTEXT_LINES + 1);
    const leading = index - start;
    const hunk = ops.slice(start, end);
    const oldCount = hunk.filter((op) => op.kind !== "+").length;
    const newCount = hunk.filter((op) => op.kind !== "-").length;
    lines.push(`@@ -${oldLine - leading},${oldCount} +${newLine - leading},${newCount} @@`);
    for (const op of hunk) lines.push(`${op.kind}${op.line}`);
    for (const op of ops.slice(index, end)) {
      if (op.kind !== "+") oldLine++;
      if (op.kind !== "-") newLine++;
    }
    index = end;
  }
  let text = `${lines.join("\n")}\n`;
  let truncated = false;
  if (Buffer.byteLength(text) > input.maxBytes) {
    text = `${Buffer.from(text).subarray(0, input.maxBytes).toString("utf8")}\n… (truncated)\n`;
    truncated = true;
  }
  return { text, truncated };
}
