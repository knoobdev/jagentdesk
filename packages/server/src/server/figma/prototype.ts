import type { FigmaInteraction, FigmaPrototype } from "@jagentdesk/protocol/figma/rpc-schemas";
import { FigmaServiceError, type FigmaLinkBridge, type FigmaRestClient } from "./context.js";

// Prototype data (spec 32.5.3, figma-integration.md §5). REST is the source of truth:
// `flowStartingPoints` lives on CANVAS (page) nodes and any node can carry `interactions`
// (`trigger` + `actions[]`, figma-integration.md §5.1). Overlay settings of a destination frame
// (`overlayPositionType`, `overlayBackground`, `overlayBackgroundInteraction`) exist only on the
// Plugin API (§5.2), so they are read through Figma Link with `get_node`; without Link the
// overlays are empty and `overlaySettingsAvailable` is false.
//
// Also hosts the raw-JSON narrowing helpers the comment mapping (handlers/comments.ts) shares.

export type Json = Record<string, unknown>;

type OverlaySettings = FigmaPrototype["overlays"][number];
type OverlayBackground = NonNullable<OverlaySettings["background"]>;
type Transition = NonNullable<FigmaInteraction["action"]["transition"]>;
type Flows = FigmaPrototype["flows"];

const OVERLAY_FIELDS = [
  "overlayPositionType",
  "overlayBackground",
  "overlayBackgroundInteraction",
] as const;

// ── Figma payload narrowing ──────────────────────────────────────────────────
// REST bodies are large and loosely typed; the daemon reads only the fields it maps.

export function obj(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

export function objs(value: unknown): Json[] {
  if (!Array.isArray(value)) return [];
  return value.map(obj).filter((item): item is Json => item !== null);
}

export function str(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value); // ids are ints in some Figma payloads
  return null;
}

export function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Figma timestamps are ISO 8601 UTC strings; some payloads carry Unix ms instead. */
export function isoMs(value: unknown, field: string): number {
  let ms: number;
  if (typeof value === "string") {
    ms = Date.parse(value);
  } else if (typeof value === "number") {
    ms = value;
  } else {
    ms = Number.NaN;
  }
  if (!Number.isFinite(ms)) {
    throw new FigmaServiceError("figma_error", `Figma sent an unreadable ${field}.`);
  }
  return ms;
}

// ── flows + interactions (REST) ──────────────────────────────────────────────

export interface PrototypeFacts {
  flows: Flows;
  interactions: FigmaInteraction[];
}

/**
 * Read `GET /v1/files/:key` (whole document or the `nodes` map the `ids` variant returns) and
 * collect every page's `flowStartingPoints` plus every node's normalized interactions.
 */
export function normalizePrototypeFile(payload: unknown, pageId?: string): PrototypeFacts {
  const pages = collectPages(payload);
  if (pages.length === 0) {
    throw new FigmaServiceError("figma_error", "Figma returned a file JAgentDesk could not read.");
  }
  const flows: Flows = [];
  const interactions: FigmaInteraction[] = [];
  for (const page of pages) {
    const pageKey = str(page.id);
    if (pageKey === null) continue;
    if (pageId !== undefined && pageKey !== pageId) continue;
    for (const point of objs(page.flowStartingPoints)) {
      const nodeId = str(point.nodeId);
      if (nodeId === null) continue;
      flows.push({ nodeId, name: str(point.name) ?? "", pageId: pageKey });
    }
    collectNodeInteractions(page, interactions);
  }
  return { flows, interactions };
}

function collectPages(payload: unknown): Json[] {
  const root = obj(payload);
  if (!root) return [];
  const document = obj(root.document);
  if (document) return objs(document.children);
  const nodes = obj(root.nodes);
  if (nodes) {
    return Object.values(nodes).map((entry) => obj(obj(entry)?.document) ?? obj(entry) ?? {});
  }
  return [];
}

function collectNodeInteractions(node: Json, out: FigmaInteraction[]): void {
  const before = out.length;
  for (const reaction of objs(node.interactions)) {
    const trigger = normalizeTrigger(reaction.trigger);
    for (const action of reactionActions(reaction)) {
      const normalized = normalizeAction(action);
      if (normalized) out.push({ nodeId: str(node.id) ?? "", trigger, action: normalized });
    }
  }
  // Pre-reactions files carry the default navigation on the node itself. Synthesize it only
  // when the node has no interactions, so modern files never produce duplicate edges.
  if (out.length === before) pushLegacyTransition(node, out);
  for (const child of objs(node.children)) collectNodeInteractions(child, out);
}

/** `delay` and `timeout` are already ms; `mediaHitTime` is in seconds (figma-api Trigger). */
function normalizeTrigger(raw: unknown): FigmaInteraction["trigger"] {
  const trigger = obj(raw);
  const normalized: FigmaInteraction["trigger"] = { type: str(trigger?.type) ?? "ON_CLICK" };
  const seconds = num(trigger?.mediaHitTime);
  const delayMs =
    num(trigger?.delay) ??
    num(trigger?.timeout) ??
    (seconds === null ? null : Math.round(seconds * 1000));
  if (delayMs !== null) normalized.delayMs = delayMs;
  return normalized;
}

function reactionActions(reaction: Json): Json[] {
  const actions = objs(reaction.actions);
  if (actions.length > 0) return actions;
  const single = obj(reaction.action); // older payloads used a single `action`
  return single ? [single] : [];
}

function normalizeAction(raw: Json): FigmaInteraction["action"] | null {
  const type = str(raw.type);
  if (type === null) return null;
  switch (type) {
    case "NODE":
      return {
        type,
        navigation: str(raw.navigation) ?? undefined,
        destinationId: str(raw.destinationId),
        transition: normalizeTransition(raw.transition),
      };
    case "URL":
      return { type, url: str(raw.url) ?? undefined };
    case "UPDATE_MEDIA_RUNTIME":
      return { type, destinationId: str(raw.destinationId) };
    default:
      // BACK, CLOSE, SET_VARIABLE, SET_VARIABLE_MODE, CONDITIONAL and anything newer: the type
      // alone is enough for the player (32.5.3).
      return { type };
  }
}

/** REST transition objects carry `duration` in ms (§5.1); the wire names it `durationMs`. */
function normalizeTransition(raw: unknown): Transition | null | undefined {
  if (raw === null) return null;
  const transition = obj(raw);
  if (!transition) return undefined;
  const normalized: Transition = { type: str(transition.type) ?? "INSTANT" };
  const direction = str(transition.direction);
  if (direction !== null) normalized.direction = direction;
  const durationMs = num(transition.duration) ?? num(transition.durationMs);
  if (durationMs !== null) normalized.durationMs = durationMs;
  const easing = easingName(transition.easing);
  if (easing !== null) normalized.easing = easing;
  return normalized;
}

/**
 * The wire keeps the easing as a string. REST sends it two ways: a bare enum on the legacy
 * node-level `transitionEasing`, or an object `{ type, easingFunctionCubicBezier }` on an
 * interaction transition — for a custom curve the control points are appended so the player
 * (32.5.3) can rebuild it: `CUSTOM_CUBIC_BEZIER(0.42,0,0.58,1)`.
 */
function easingName(raw: unknown): string | null {
  const bare = str(raw);
  if (bare !== null) return bare;
  const easing = obj(raw);
  const type = str(easing?.type);
  if (type === null) return null;
  const bezier = obj(easing?.easingFunctionCubicBezier);
  if (!bezier) return type;
  const points = [bezier.x1, bezier.y1, bezier.x2, bezier.y2].map(num);
  return points.some((point) => point === null) ? type : `${type}(${points.join(",")})`;
}

function pushLegacyTransition(node: Json, out: FigmaInteraction[]): void {
  const destinationId = str(node.transitionNodeID);
  if (destinationId === null) return;
  const transition: Transition = { type: "DISSOLVE" }; // Figma's default legacy transition
  const durationMs = num(node.transitionDuration);
  if (durationMs !== null) transition.durationMs = durationMs;
  const easing = easingName(node.transitionEasing);
  if (easing !== null) transition.easing = easing;
  out.push({
    nodeId: str(node.id) ?? "",
    trigger: { type: "ON_CLICK" },
    action: { type: "NODE", navigation: "NAVIGATE", destinationId, transition },
  });
}

// ── overlays (Figma Link) ────────────────────────────────────────────────────

/** Destination frames opened as overlays — their Plugin-API node carries the overlay settings. */
export function collectOverlayDestinations(interactions: FigmaInteraction[]): string[] {
  const seen = new Set<string>();
  const frameIds: string[] = [];
  for (const { action } of interactions) {
    if (action.type !== "NODE") continue;
    if (action.navigation !== "OVERLAY" && action.navigation !== "SWAP") continue;
    const destinationId = action.destinationId;
    if (!destinationId || seen.has(destinationId)) continue;
    seen.add(destinationId);
    frameIds.push(destinationId);
  }
  return frameIds;
}

export async function buildPrototype(input: {
  fileKey: string;
  connectionId: string;
  pageId?: string;
  rest: FigmaRestClient;
  link: FigmaLinkBridge;
}): Promise<FigmaPrototype> {
  const payload = await input.rest.getJson({
    connectionId: input.connectionId,
    path: `/v1/files/${input.fileKey}`,
    tier: "1",
  });
  const { flows, interactions } = normalizePrototypeFile(payload, input.pageId);
  const overlays: OverlaySettings[] = [];
  const overlaySettingsAvailable = input.link.isLinked(input.fileKey);
  if (overlaySettingsAvailable) {
    for (const frameId of collectOverlayDestinations(interactions)) {
      const result = await input.link.callTool(input.fileKey, "get_node", { nodeId: frameId });
      const overlay = normalizeOverlaySettings(frameId, result);
      if (overlay) overlays.push(overlay);
    }
  }
  return { flows, interactions, overlays, overlaySettingsAvailable };
}

export function normalizeOverlaySettings(
  frameId: string,
  toolResult: unknown,
): OverlaySettings | null {
  const node = findOverlayNode(toolResult);
  if (!node) return null;
  const position = str(node.overlayPositionType);
  const background = normalizeOverlayBackground(node.overlayBackground);
  const interaction = str(node.overlayBackgroundInteraction);
  if (position === null && background === undefined && interaction === null) return null;
  const overlay: OverlaySettings = { frameId, position: position ?? "CENTER" };
  if (background !== undefined) overlay.background = background;
  if (interaction !== null) overlay.closeOnClickOutside = interaction === "CLOSE_ON_CLICK_OUTSIDE";
  return overlay;
}

/**
 * The Link plugin returns a node in one of several envelopes (the node itself, `{ node }`, the
 * REST-style `{ nodes: { id: { document } } }` map, or MCP `{ content: [{ text }] }`); unwrap
 * until a node carrying overlay fields shows up.
 */
function findOverlayNode(value: unknown, depth = 0): Json | null {
  if (depth > 4 || value === null || value === undefined) return null;
  if (typeof value === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
    return findOverlayNode(parsed, depth + 1);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findOverlayNode(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const record = obj(value);
  if (!record) return null;
  if (OVERLAY_FIELDS.some((field) => field in record)) return record;
  const candidates: unknown[] = [
    record.node,
    record.document,
    record.result,
    record.data,
    record.text,
  ];
  const nodes = obj(record.nodes);
  if (nodes) candidates.push(...Object.values(nodes));
  const content = record.content;
  if (Array.isArray(content)) candidates.push(...content);
  for (const candidate of candidates) {
    const found = findOverlayNode(candidate, depth + 1);
    if (found) return found;
  }
  return null;
}

function normalizeOverlayBackground(raw: unknown): OverlayBackground | undefined {
  const paint = Array.isArray(raw) ? obj(raw[0]) : obj(raw);
  if (!paint) return undefined;
  const type = str(paint.type);
  if (type === null) return undefined;
  if (type === "NONE") return { type };
  const color = obj(paint.color);
  const hex = color === null ? null : rgbaToHex(color, num(paint.opacity));
  return hex === null ? { type } : { type, color: hex };
}

function rgbaToHex(color: Json, opacity: number | null): string | null {
  const r = channel(color.r);
  const g = channel(color.g);
  const b = channel(color.b);
  const a = channel(color.a ?? opacity ?? 1);
  if (r === null || g === null || b === null || a === null) return null;
  return `#${[r, g, b, a].map((v) => v.toString(16).padStart(2, "0").toUpperCase()).join("")}`;
}

function channel(value: unknown): number | null {
  const n = num(value); // Figma colors are 0..1 floats
  return n === null ? null : Math.min(255, Math.max(0, Math.round(n * 255)));
}
