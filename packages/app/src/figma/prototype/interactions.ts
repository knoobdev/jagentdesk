import type { FigmaInteraction } from "@jagentdesk/protocol/figma/rpc-schemas";
import { planTransition, type TransitionPlan } from "./transition-timeline";

// The wire keeps triggers/actions as raw strings (Figma's own vocabulary, normalized by the
// daemon). This is the single boundary that narrows them into typed shapes the player's
// state machine and hotspot layer consume. Anything unrecognized parses to "ignore".

export type TriggerKind = "ON_CLICK" | "ON_HOVER" | "ON_PRESS" | "AFTER_TIMEOUT" | "OTHER";

export type ParsedAction =
  | { kind: "navigate"; destinationId: string; transition: TransitionPlan | null }
  | { kind: "overlay"; destinationId: string }
  | { kind: "swap"; destinationId: string }
  | { kind: "scroll_to"; destinationId: string }
  | { kind: "close" }
  | { kind: "back" }
  | { kind: "url"; url: string }
  | { kind: "ignore" };

export interface ParsedInteraction {
  nodeId: string;
  trigger: TriggerKind;
  delayMs: number;
  action: ParsedAction;
}

export type InteractionMap = ReadonlyMap<string, readonly ParsedInteraction[]>;

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const TRIGGERS = new Set<TriggerKind>(["ON_CLICK", "ON_HOVER", "ON_PRESS", "AFTER_TIMEOUT"]);

function parseTriggerType(value: unknown): TriggerKind {
  const raw = readString(value);
  return raw && TRIGGERS.has(raw as TriggerKind) ? (raw as TriggerKind) : "OTHER";
}

/** Maps the wire's action object onto one typed action; unknown combinations are ignored. */
export function parseAction(action: FigmaInteraction["action"]): ParsedAction {
  const type = readString(action?.type);
  const navigation = readString(action?.navigation);
  const destinationId = readString(action?.destinationId);
  const transition = action?.transition ?? null;
  if (type === "BACK") return { kind: "back" };
  if (type === "CLOSE") return { kind: "close" };
  if (type === "URL") {
    const url = readString(action?.url);
    return url ? { kind: "url", url } : { kind: "ignore" };
  }
  if (type !== "NODE" || !destinationId) return { kind: "ignore" };
  if (navigation === "OVERLAY") return { kind: "overlay", destinationId };
  if (navigation === "SWAP") return { kind: "swap", destinationId };
  if (navigation === "SCROLL_TO") return { kind: "scroll_to", destinationId };
  // Figma's Navigation enum is NAVIGATE | SWAP | OVERLAY | SCROLL_TO | CHANGE_TO. Only the
  // screen-to-screen kinds play here: CHANGE_TO retargets a component instance (no player
  // state-machine consumer yet) and anything newer must not become a wrong frame jump, so
  // anything outside the navigate vocabulary is ignored rather than treated as NAVIGATE.
  // A missing navigation is the legacy node-level transition the daemon synthesizes, which is
  // a plain NAVIGATE.
  if (navigation !== null && navigation !== "NAVIGATE") return { kind: "ignore" };
  return {
    kind: "navigate",
    destinationId,
    transition: transition ? planTransition(transition) : null,
  };
}

export function parseInteraction(interaction: FigmaInteraction): ParsedInteraction {
  return {
    nodeId: interaction.nodeId,
    trigger: parseTriggerType(interaction.trigger?.type),
    delayMs: Math.max(0, readNumber(interaction.trigger?.delayMs) ?? 0),
    action: parseAction(interaction.action),
  };
}

/** Interactions keyed by the node whose hit area carries them, in wire order. */
export function indexInteractions(interactions: readonly FigmaInteraction[]): InteractionMap {
  const byNode = new Map<string, ParsedInteraction[]>();
  for (const raw of interactions) {
    const parsed = parseInteraction(raw);
    if (parsed.trigger === "OTHER" || parsed.action.kind === "ignore") continue;
    const list = byNode.get(parsed.nodeId);
    if (list) list.push(parsed);
    else byNode.set(parsed.nodeId, [parsed]);
  }
  return byNode;
}

export function interactionsForNode(
  map: InteractionMap,
  nodeId: string,
): readonly ParsedInteraction[] {
  return map.get(nodeId) ?? [];
}

/** The frame a node's AFTER_TIMEOUT interaction advances to, if any. */
export function afterTimeoutForNode(
  map: InteractionMap,
  nodeId: string,
): { delayMs: number; action: ParsedAction } | null {
  for (const interaction of interactionsForNode(map, nodeId)) {
    if (interaction.trigger === "AFTER_TIMEOUT") {
      return { delayMs: interaction.delayMs, action: interaction.action };
    }
  }
  return null;
}
