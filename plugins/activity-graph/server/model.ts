import { createHash } from "node:crypto";
import { parseSpecModeMessage, specModePhaseLabel } from "@jagentdesk/protocol/spec-mode";
import type {
  ActivityGraphNodeKind,
  ActivityGraphNodeRef,
  ActivityGraphNodeStatus,
  ActivityGraphTurnSummary,
  ActivityGraphView,
} from "@jagentdesk/protocol/agent-activity-graph";

// Renderer-independent graph the builders produce (spec 31.1–31.2). archify-json.ts turns it into
// archify JSON; the service diffs two models to decide between a re-render and a status push.

export interface GraphNode {
  id: string;
  kind: ActivityGraphNodeKind;
  label: string;
  sublabel?: string;
  tag?: string;
  status: ActivityGraphNodeStatus;
  ref: ActivityGraphNodeRef;
  // Flow: "main" nodes form the left-to-right path in order; "branch" nodes hang below `parentId`.
  // Plan: every node except the root has a `parentId` (tree containment).
  placement: "main" | "branch";
  parentId?: string;
  // Flow branches that hand control back (a subagent returning, an approval granted) get a return
  // transition, so they do not read as final states.
  returns?: boolean;
  // Flow only: the transition into this node is an error route (permission denied).
  errorEdge?: boolean;
  // Flow only: the transition into this node is a plan (not yet taken) route.
  plannedEdge?: boolean;
}

export interface GraphModel {
  view: ActivityGraphView;
  title: string;
  nodes: GraphNode[];
}

export interface ActivityGraphTurns {
  turns: ActivityGraphTurnSummary[];
  turnIndex: number;
  live: boolean;
}

// Spec 31.2: at most 40 nodes per turn.
export const MAX_FLOW_NODES = 40;
// Spec 31.4: the turn picker lists the 10 most recent turns.
export const TURN_PICKER_LIMIT = 10;
// Spec 31.2: the start node shows the first line of the prompt, at most 60 characters.
export const PROMPT_LABEL_MAX = 60;

const ARCHIFY_ID = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

// archify ids must match ^[a-zA-Z][a-zA-Z0-9_-]*$. Ids derive from provider identifiers (callId,
// subagent id, request id, todo id), which may contain other characters; those get a hash suffix so
// two different sources never collide after sanitising.
export function stableNodeId(prefix: string, source: string): string {
  const candidate = `${prefix}-${source}`;
  if (ARCHIFY_ID.test(candidate) && candidate.length <= 96) return candidate;
  const cleaned = source.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 48);
  return `${prefix}-${cleaned}-${shortHash(source)}`;
}

export function hashNodeId(prefix: string, text: string): string {
  return `${prefix}-h${shortHash(text)}`;
}

// archify's width estimate (renderers/shared/utils.mjs textUnits): wide East Asian characters and
// emoji take two units, everything else one; labels and sublabels are cut in units.
const FULLWIDTH =
  /[\u1100-\u115F\u231A-\u231B\u2329-\u232A\u23E9-\u23EC\u23F0\u23F3\u25FD-\u25FE\u2614-\u2615\u2630-\u2637\u2648-\u2653\u267F\u268A-\u268F\u2693\u26A1\u26AA-\u26AB\u26BD-\u26BE\u26C4-\u26C5\u26CE\u26D4\u26EA\u26F2-\u26F3\u26F5\u26FA\u26FD\u2705\u270A-\u270B\u2728\u274C\u274E\u2753-\u2755\u2757\u2795-\u2797\u27B0\u27BF\u2B1B-\u2B1C\u2B50\u2B55\u2E80-\uA4CF\uA960-\uA97C\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF01-\uFF60\uFFE0-\uFFE6\u{16FE0}-\u{18DFF}\u{1AFF0}-\u{1AFFF}\u{1B000}-\u{1B2FF}\u{1F000}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;

// Tool labels and sublabels stay short so most cards keep to one or two lines in the tree.
export const LABEL_UNITS = 29;
export const SUBLABEL_UNITS = 38;

function charUnits(char: string): number {
  return FULLWIDTH.test(char) ? 2 : 1;
}

export function textUnits(text: string): number {
  let units = 0;
  for (const char of Array.from(text)) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0xfe00 && code <= 0xfe0f) continue;
    units += charUnits(char);
  }
  return units;
}

// Collapse whitespace and cut to `maxUnits` archify text units, ending with an ellipsis when cut.
export function truncateText(text: string, maxUnits: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (textUnits(collapsed) <= maxUnits) return collapsed;
  let units = 0;
  let out = "";
  for (const char of Array.from(collapsed)) {
    const width = charUnits(char);
    if (units + width > maxUnits - 1) break;
    out += char;
    units += width;
  }
  return `${out.trimEnd()}…`;
}

// First non-empty line, at most `max` characters (spec 31.2: the start node label, ≤ 60).
/**
 * The prompt text a graph label is cut from. A Spec mode phase command (`/speckit-…` or a whole
 * rendered spec-kit template) reads as "Specify · <what the user wrote>", or "Spec mode · Plan"
 * after Approve, never as the command itself (spec 28.4 step 2).
 */
export function promptLabelSource(text: string): string {
  const spec = parseSpecModeMessage(text);
  if (!spec) return text;
  const phase = specModePhaseLabel(spec.phase);
  const request = spec.userText ? firstLine(spec.userText, Number.MAX_SAFE_INTEGER) : "";
  return request ? `${phase} · ${request}` : `Spec mode · ${phase}`;
}

export function firstLine(text: string, max = PROMPT_LABEL_MAX): string {
  const line =
    text
      .split(/\r?\n/)
      .map((part) => part.trim())
      .find((part) => part.length > 0) ?? "";
  const collapsed = line.replace(/\s+/g, " ");
  if (Array.from(collapsed).length <= max) return collapsed;
  return `${Array.from(collapsed)
    .slice(0, max - 1)
    .join("")
    .trimEnd()}…`;
}

// What decides whether the HTML must be rendered again: anything archify draws except the status
// (statuses are painted by the app's overlay, spec 31.3).
export function structureKey(model: GraphModel): string {
  return JSON.stringify([
    model.view,
    model.title,
    model.nodes.map((node) => [
      node.id,
      node.kind,
      node.label,
      node.sublabel ?? "",
      node.tag ?? "",
      node.placement,
      node.parentId ?? "",
      node.returns === true,
      node.errorEdge === true,
      node.plannedEdge === true,
    ]),
  ]);
}

export function nodeStatuses(model: GraphModel): { id: string; status: ActivityGraphNodeStatus }[] {
  return model.nodes.map((node) => ({ id: node.id, status: node.status }));
}

export function nodeIndexOf(model: GraphModel): Record<string, ActivityGraphNodeRef> {
  const index: Record<string, ActivityGraphNodeRef> = {};
  for (const node of model.nodes) index[node.id] = node.ref;
  return index;
}
