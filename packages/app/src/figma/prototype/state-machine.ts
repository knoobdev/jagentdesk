import type { ParsedAction } from "./interactions";
import type { TransitionPlan } from "./transition-timeline";

// The prototype player's navigation model (spec 32.5.3) as a pure state machine: a top-level
// frame stack (for BACK), an overlay stack (OVERLAY/SWAP/CLOSE), an active transition, and the
// pending AFTER_TIMEOUT for the current frame. The view owns timers and the URL opener; every
// side effect leaves `step` in `effects` so the machine stays unit-testable and deterministic.

export type OverlayPosition =
  | "CENTER"
  | "TOP_LEFT"
  | "TOP_CENTER"
  | "TOP_RIGHT"
  | "BOTTOM_LEFT"
  | "BOTTOM_CENTER"
  | "BOTTOM_RIGHT"
  | "MANUAL";

export interface OverlaySettings {
  position: OverlayPosition;
  /** Background dim colour (rgba string); empty when the overlay draws no dim layer. */
  dimColor: string;
  closeOnClickOutside: boolean;
}

export interface OverlayEntry {
  frameId: string;
  settings: OverlaySettings;
}

export interface ActiveTransition {
  fromFrameId: string;
  toFrameId: string;
  plan: TransitionPlan;
  startedAt_ms: number;
}

export interface PendingTimeout {
  frameId: string;
  delayMs: number;
}

export interface PlayerState {
  startFrameId: string | null;
  /** Top-level frames visited; the last entry is the frame on stage. */
  stack: string[];
  /** Open overlays; the last entry is on top of everything. */
  overlays: OverlayEntry[];
  transition: ActiveTransition | null;
  timeout: PendingTimeout | null;
}

export type PlayerEvent =
  | { type: "start"; frameId: string }
  | { type: "interaction"; action: ParsedAction }
  | { type: "toolbar_back" }
  | { type: "toolbar_restart" }
  | { type: "overlay_dismiss" }
  | { type: "timeout_fire" }
  | { type: "transition_complete" };

export type PlayerEffect =
  | { kind: "open_url"; url: string }
  | { kind: "scroll_to"; frameId: string; targetId: string };

export interface PlayerContext {
  /** Injectable clock; tests pass fixed stamps for determinism. */
  now_ms: () => number;
  overlaySettingsFor: (frameId: string) => OverlaySettings;
  afterTimeoutFor: (frameId: string) => { delayMs: number; action: ParsedAction } | null;
}

export interface StepResult {
  state: PlayerState;
  effects: PlayerEffect[];
}

/** Figma's own overlay defaults, used when neither Link nor the wire gives settings. */
export const DEFAULT_OVERLAY_SETTINGS: OverlaySettings = {
  position: "CENTER",
  dimColor: "rgba(0, 0, 0, 0.5)",
  closeOnClickOutside: true,
};

const OVERLAY_POSITIONS = new Set<OverlayPosition>([
  "CENTER",
  "TOP_LEFT",
  "TOP_CENTER",
  "TOP_RIGHT",
  "BOTTOM_LEFT",
  "BOTTOM_CENTER",
  "BOTTOM_RIGHT",
  "MANUAL",
]);

/** Narrows the wire position string; MANUAL has no relative offset in REST, so it centers. */
export function parseOverlayPosition(value: string | undefined): OverlayPosition {
  return value && OVERLAY_POSITIONS.has(value as OverlayPosition) && value !== "MANUAL"
    ? (value as OverlayPosition)
    : "CENTER";
}

export function emptyPlayerState(): PlayerState {
  return { startFrameId: null, stack: [], overlays: [], transition: null, timeout: null };
}

export function currentFrameId(state: PlayerState): string | null {
  const top = state.overlays[state.overlays.length - 1];
  if (top) return top.frameId;
  return state.stack.length > 0 ? state.stack[state.stack.length - 1] : null;
}

/**
 * The frame UNDER the overlay stack — what the stage must keep drawing while an overlay is
 * open (G5 bug 2). Using `currentFrameId` instead made the base canvas follow the top overlay,
 * so opening a sheet replaced the frame behind it: a flat dim backdrop with nothing under it.
 */
export function baseFrameIdFor(state: PlayerState): string | null {
  const top = state.stack[state.stack.length - 1];
  return top ?? null;
}

function timeoutFor(state: PlayerState, ctx: PlayerContext): PendingTimeout | null {
  const frameId = currentFrameId(state);
  if (!frameId) return null;
  const pending = ctx.afterTimeoutFor(frameId);
  return pending ? { frameId, delayMs: pending.delayMs } : null;
}

/** AFTER_TIMEOUT fires once per arrival on a frame; re-entry re-arms it. */
function commit(state: PlayerState, ctx: PlayerContext): PlayerState {
  return { ...state, timeout: timeoutFor(state, ctx) };
}

function applyAction(state: PlayerState, action: ParsedAction, ctx: PlayerContext): StepResult {
  if (action.kind === "back") {
    return { state: commit(goBack(state), ctx), effects: [] };
  }
  if (action.kind === "close") {
    if (state.overlays.length === 0) return { state, effects: [] };
    return { state: commit(closeTopOverlay(state), ctx), effects: [] };
  }
  if (action.kind === "url") {
    return { state, effects: [{ kind: "open_url", url: action.url }] };
  }
  if (action.kind === "scroll_to") {
    const frameId = currentFrameId(state);
    if (!frameId) return { state, effects: [] };
    return { state, effects: [{ kind: "scroll_to", frameId, targetId: action.destinationId }] };
  }
  if (action.kind === "ignore") {
    return { state, effects: [] };
  }
  if (action.kind === "overlay") {
    const overlays = [
      ...state.overlays,
      { frameId: action.destinationId, settings: ctx.overlaySettingsFor(action.destinationId) },
    ];
    return { state: commit({ ...state, overlays }, ctx), effects: [] };
  }
  if (action.kind === "swap") {
    if (state.overlays.length === 0) {
      return applyAction(state, { kind: "overlay", destinationId: action.destinationId }, ctx);
    }
    const overlays = [...state.overlays];
    overlays[overlays.length - 1] = {
      frameId: action.destinationId,
      settings: ctx.overlaySettingsFor(action.destinationId),
    };
    return { state: commit({ ...state, overlays }, ctx), effects: [] };
  }
  const from = currentFrameId(state);
  if (!from) return { state, effects: [] };
  const stack = [...state.stack, action.destinationId];
  const plan = action.transition;
  const running = plan && plan.type !== "INSTANT";
  const transition: ActiveTransition | null = running
    ? {
        fromFrameId: from,
        toFrameId: action.destinationId,
        plan,
        startedAt_ms: ctx.now_ms(),
      }
    : null;
  return { state: commit({ ...state, stack, transition }, ctx), effects: [] };
}

function goBack(state: PlayerState): PlayerState {
  if (state.overlays.length > 0) return closeTopOverlay(state);
  if (state.stack.length <= 1) return state;
  return { ...state, stack: state.stack.slice(0, -1) };
}

function closeTopOverlay(state: PlayerState): PlayerState {
  return { ...state, overlays: state.overlays.slice(0, -1) };
}

export function step(state: PlayerState, event: PlayerEvent, ctx: PlayerContext): StepResult {
  switch (event.type) {
    case "start": {
      const started: PlayerState = {
        startFrameId: event.frameId,
        stack: [event.frameId],
        overlays: [],
        transition: null,
        timeout: null,
      };
      return { state: commit(started, ctx), effects: [] };
    }
    case "interaction":
      return applyAction(state, event.action, ctx);
    case "toolbar_back":
      return { state: commit(goBack(state), ctx), effects: [] };
    case "toolbar_restart": {
      if (!state.startFrameId) return { state, effects: [] };
      const restarted: PlayerState = {
        ...state,
        stack: [state.startFrameId],
        overlays: [],
        transition: null,
        timeout: null,
      };
      return { state: commit(restarted, ctx), effects: [] };
    }
    case "overlay_dismiss": {
      const top = state.overlays[state.overlays.length - 1];
      if (!top || !top.settings.closeOnClickOutside) return { state, effects: [] };
      return { state: commit(closeTopOverlay(state), ctx), effects: [] };
    }
    case "timeout_fire": {
      const frameId = currentFrameId(state);
      if (!state.timeout) return { state, effects: [] };
      if (!frameId || state.timeout.frameId !== frameId) {
        return { state: { ...state, timeout: null }, effects: [] };
      }
      const pending = ctx.afterTimeoutFor(frameId);
      if (!pending) return { state: { ...state, timeout: null }, effects: [] };
      return applyAction({ ...state, timeout: null }, pending.action, ctx);
    }
    case "transition_complete":
      return { state: { ...state, transition: null }, effects: [] };
  }
}
