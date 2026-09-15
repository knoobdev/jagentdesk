// Minimal ANSI-log parser for CI job logs (GitLab/GitHub runners emit ANSI SGR
// color codes, `\x1b[K` erase-line, `\r` progress overwrites, and GitLab
// `section_start`/`section_end` fold markers). We render logs ourselves (RN Text,
// no terminal emulator), so this turns a raw log string into per-line colored
// segments the viewer draws with a line-number gutter. No dependency.

export interface AnsiSegment {
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
}

export interface AnsiLine {
  segments: AnsiSegment[];
}

// Standard 16-color ANSI foreground palette, tuned to read on a dark log surface.
const FG: Record<number, string> = {
  30: "#6b7280",
  31: "#f87171",
  32: "#4ade80",
  33: "#fbbf24",
  34: "#60a5fa",
  35: "#c084fc",
  36: "#22d3ee",
  37: "#d4d4d4",
  90: "#9ca3af",
  91: "#fca5a5",
  92: "#86efac",
  93: "#fde047",
  94: "#93c5fd",
  95: "#d8b4fe",
  96: "#67e8f9",
  97: "#f5f5f5",
};

// eslint-disable-next-line no-control-regex
const CSI = /\x1b\[([0-9;]*)([A-Za-z])/g;
// GitLab fold markers: `section_start:<unixTs>:<name>` / `section_end:<unixTs>:<name>`.
const SECTION = /^section_(start|end):\d+:\S*/;

interface SgrState {
  color?: string;
  bold: boolean;
  dim: boolean;
}

function applySgr(state: SgrState, params: string): SgrState {
  // Empty params ("\x1b[m") means reset, same as "0".
  const codes = params === "" ? [0] : params.split(";").map((p) => Number(p) || 0);
  let next = { ...state };
  for (const code of codes) {
    if (code === 0) next = { bold: false, dim: false };
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 22) {
      next.bold = false;
      next.dim = false;
    } else if (code === 39) next.color = undefined;
    else if (FG[code]) next.color = FG[code];
  }
  return next;
}

// Resolve a single physical line (already free of `\n`) honoring `\r` overwrites:
// a carriage return rewinds to column 0, so the last `\r`-separated chunk wins.
// This also drops GitLab's `section_start:ts:name\r` prefix (the visible header
// text follows the final `\r`), and turns a bare `section_end` line into empty.
function resolveCarriageReturns(raw: string): string {
  if (!raw.includes("\r")) return raw;
  const parts = raw.split("\r");
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const candidate = parts[i];
    if (candidate.replace(CSI, "").length > 0) return candidate;
  }
  return "";
}

function parseLine(raw: string, carry: SgrState): { line: AnsiLine; state: SgrState } {
  const resolved = resolveCarriageReturns(raw);
  const segments: AnsiSegment[] = [];
  let state = carry;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  CSI.lastIndex = 0;
  const pushText = (text: string) => {
    if (!text) return;
    segments.push({
      text,
      ...(state.color ? { color: state.color } : {}),
      ...(state.bold ? { bold: true } : {}),
      ...(state.dim ? { dim: true } : {}),
    });
  };
  while ((match = CSI.exec(resolved)) !== null) {
    pushText(resolved.slice(lastIndex, match.index));
    lastIndex = match.index + match[0].length;
    // Only SGR ("m") changes styling; erase/cursor codes (K, G, …) are dropped.
    if (match[2] === "m") state = applySgr(state, match[1]);
  }
  pushText(resolved.slice(lastIndex));
  if (segments.length === 0) segments.push({ text: "" });
  return { line: { segments }, state };
}

/** Parse a raw CI log into styled lines. GitLab `section_end` markers collapse to
 *  nothing; `section_start` keeps only its human header. Trailing blank line (from
 *  a final newline) is dropped so the gutter count matches the visible content. */
export function parseAnsiLog(raw: string): AnsiLine[] {
  if (!raw) return [];
  const physical = raw.replace(/\r\n/g, "\n").split("\n");
  if (physical.length > 1 && physical[physical.length - 1] === "") physical.pop();
  const lines: AnsiLine[] = [];
  let state: SgrState = { bold: false, dim: false };
  for (const rawLine of physical) {
    // A standalone section_end marker carries no visible text — skip it entirely.
    const stripped = rawLine.replace(CSI, "").replace(/\r/g, "");
    if (SECTION.test(stripped) && stripped.startsWith("section_end:")) {
      continue;
    }
    const { line, state: nextState } = parseLine(rawLine, state);
    state = nextState;
    lines.push(line);
  }
  return lines;
}

/** Strip every ANSI/control sequence for a plain-text copy of the log. Mirrors
 *  parseAnsiLog's line handling (carriage-return overwrite + section folds) so the
 *  copied text matches what the viewer shows. */
export function stripAnsi(raw: string): string {
  if (!raw) return "";
  const physical = raw.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of physical) {
    const flat = line.replace(CSI, "").replace(/\r/g, "");
    if (SECTION.test(flat) && flat.startsWith("section_end:")) continue;
    out.push(resolveCarriageReturns(line).replace(CSI, ""));
  }
  return out.join("\n");
}
