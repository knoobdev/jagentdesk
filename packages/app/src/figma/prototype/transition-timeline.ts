import type { FigmaInteraction } from "@jagentdesk/protocol/figma/rpc-schemas";
import { resolveEasing, type EasingFn } from "./easing";

// The wire exports no `FigmaTransition` type, so derive it from the interaction it rides on —
// the protocol stays the single source of the shape.
export type FigmaTransition = NonNullable<Exclude<FigmaInteraction["action"]["transition"], null>>;

// Transition planning and the per-frame clock (spec 32.5.3). `planTransition` normalizes the
// wire object into typed fields; `advanceTimeline` turns elapsed time into an eased progress;
// `transitionVisuals` turns that progress into opacity/offset for the two frames, which the
// player applies to the stage layers. Direction vectors are unit offsets in frame sizes.

export type TransitionType =
  | "INSTANT"
  | "DISSOLVE"
  | "MOVE_IN"
  | "MOVE_OUT"
  | "PUSH"
  | "SLIDE_IN"
  | "SLIDE_OUT"
  | "SMART_ANIMATE";

export type TransitionDirection = "LEFT" | "RIGHT" | "TOP" | "BOTTOM";

export interface TransitionPlan {
  type: TransitionType;
  direction: TransitionDirection | null;
  durationMs: number;
  easing: string;
}

const TRANSITION_TYPES = new Set<TransitionType>([
  "INSTANT",
  "DISSOLVE",
  "MOVE_IN",
  "MOVE_OUT",
  "PUSH",
  "SLIDE_IN",
  "SLIDE_OUT",
  "SMART_ANIMATE",
]);

const DIRECTIONS = new Set<TransitionDirection>(["LEFT", "RIGHT", "TOP", "BOTTOM"]);

const DEFAULT_DURATION_MS = 300;

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Normalizes the wire transition; anything unrecognized plays as INSTANT. */
export function planTransition(transition: FigmaTransition | null | undefined): TransitionPlan {
  const type = readString(transition?.type);
  if (!type || !TRANSITION_TYPES.has(type as TransitionType)) {
    return { type: "INSTANT", direction: null, durationMs: 0, easing: "LINEAR" };
  }
  const named = type as TransitionType;
  if (named === "INSTANT") {
    return { type: "INSTANT", direction: null, durationMs: 0, easing: "LINEAR" };
  }
  const direction = readString(transition?.direction);
  const durationMs = readNumber(transition?.durationMs) ?? DEFAULT_DURATION_MS;
  return {
    type: named,
    direction: pickDirection(named, direction),
    durationMs,
    easing: readString(transition?.easing) ?? "EASE_IN_AND_OUT",
  };
}

/** Directional transitions fall back to RIGHT; non-directional ones carry no direction. */
function pickDirection(type: TransitionType, direction: string | null): TransitionDirection | null {
  if (!isDirectional(type)) return null;
  if (direction && DIRECTIONS.has(direction as TransitionDirection)) {
    return direction as TransitionDirection;
  }
  return "RIGHT";
}

function isDirectional(type: TransitionType): boolean {
  return (
    type === "MOVE_IN" ||
    type === "MOVE_OUT" ||
    type === "PUSH" ||
    type === "SLIDE_IN" ||
    type === "SLIDE_OUT"
  );
}

export interface TimelineSample {
  /** Raw time fraction 0–1 (un-eased), for tests and chaining. */
  progress: number;
  /** Eased value fed to the visuals; ≥ 1 when the timeline is over. */
  eased: number;
  done: boolean;
}

export function advanceTimeline(
  plan: TransitionPlan,
  elapsedMs: number,
  easingFn?: EasingFn,
): TimelineSample {
  if (plan.type === "INSTANT" || plan.durationMs <= 0) {
    return { progress: 1, eased: 1, done: true };
  }
  const progress = Math.max(0, Math.min(elapsedMs / plan.durationMs, 1));
  const easing = easingFn ?? resolveEasing(plan.easing);
  return { progress, eased: easing(progress), done: progress >= 1 };
}

export interface TransitionVisuals {
  fromOpacity: number;
  toOpacity: number;
  /** Offsets in frame sizes: 1 = one frame width/height along the direction vector. */
  fromOffset: { x: number; y: number };
  toOffset: { x: number; y: number };
}

function directionVector(direction: TransitionDirection | null): { x: number; y: number } {
  switch (direction) {
    case "LEFT":
      return { x: -1, y: 0 };
    case "TOP":
      return { x: 0, y: -1 };
    case "BOTTOM":
      return { x: 0, y: 1 };
    case "RIGHT":
    default:
      return { x: 1, y: 0 };
  }
}

function signed(value: number): number {
  return value === 0 ? 0 : value;
}

/**
 * Layer choreography per eased progress `e` (0 → transition start, 1 → end).
 * MOVE_IN slides the incoming frame in from the direction edge; MOVE_OUT slides the outgoing
 * frame away to it; PUSH moves both together; SLIDE_IN combines the incoming slide with a fade
 * of the outgoing frame; SLIDE_OUT combines the outgoing slide with a fade-in of the incoming
 * frame; DISSOLVE/SMART_ANIMATE crossfade (smart animate adds per-layer overrides elsewhere).
 */
export function transitionVisuals(plan: TransitionPlan, eased: number): TransitionVisuals {
  const e = Math.max(0, Math.min(eased, 1));
  const vector = directionVector(plan.direction);
  const none = { x: 0, y: 0 };
  if (plan.type === "INSTANT") {
    return { fromOpacity: 0, toOpacity: 1, fromOffset: none, toOffset: none };
  }
  if (plan.type === "DISSOLVE" || plan.type === "SMART_ANIMATE") {
    return { fromOpacity: 1 - e, toOpacity: e, fromOffset: none, toOffset: none };
  }
  const toEnter = { x: signed(vector.x * (1 - e)), y: signed(vector.y * (1 - e)) };
  const fromExit = { x: signed(-vector.x * e), y: signed(-vector.y * e) };
  if (plan.type === "MOVE_IN") {
    return { fromOpacity: 1, toOpacity: 1, fromOffset: none, toOffset: toEnter };
  }
  if (plan.type === "MOVE_OUT") {
    return { fromOpacity: 1, toOpacity: 1, fromOffset: fromExit, toOffset: none };
  }
  if (plan.type === "PUSH") {
    return { fromOpacity: 1, toOpacity: 1, fromOffset: fromExit, toOffset: toEnter };
  }
  if (plan.type === "SLIDE_IN") {
    return { fromOpacity: 1 - e, toOpacity: 1, fromOffset: none, toOffset: toEnter };
  }
  return { fromOpacity: 1, toOpacity: e, fromOffset: fromExit, toOffset: none };
}
