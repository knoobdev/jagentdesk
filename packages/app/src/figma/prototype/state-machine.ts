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
  /** Whether interactions have arrived for this visit (including frames without a timer). */
  timeoutResolved: boolean;
}

export type PlayerEvent =
  | { type: "start"; frameId: string }
  | { type: "interaction"; action: ParsedAction }
  | { type: "toolbar_back" }
  | { type: "toolbar_restart" }
  | { type: "overlay_dismiss" }
  | { type: "timeout_fire" }
  | { type: "transition_complete" }
  | { type: "frame_ready"; frameId: string };

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
  return {
    startFrameId: null,
    stack: [],
    overlays: [],
    transition: null,
    timeout: null,
    timeoutResolved: false,
  };
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

/** Only pixels still on stage need node trees; Back history keeps IDs only. */
export function visibleFrameIds(state: PlayerState): string[] {
  const base = baseFrameIdFor(state);
  const ids = base ? [base] : [];
  ids.push(...state.overlays.map((entry) => entry.frameId));
  if (state.transition) ids.push(state.transition.fromFrameId, state.transition.toFrameId);
  return [...new Set(ids)];
}

function timeoutFor(state: PlayerState, ctx: PlayerContext): PendingTimeout | null {
  const frameId = currentFrameId(state);
  if (!frameId) return null;
  const pending = ctx.afterTimeoutFor(frameId);
  return pending ? { frameId, delayMs: pending.delayMs } : null;
}

/** Two arms are the same answer when frame and delay match — including both being absent. */
function sameArm(current: PendingTimeout | null, pending: PendingTimeout | null): boolean {
  if (current === null || pending === null) return current === pending;
  return current.frameId === pending.frameId && current.delayMs === pending.delayMs;
}

/**
 * Arrival on a new frame clears the timer (ADR-0037): the AFTER_TIMEOUT must not start before
 * the frame's interaction data is on hand, so only `frame_ready` arms it. `timeoutResolved`
 * false means "this visit has not been resolved yet" — the view fires `frame_ready` once the
 * frame's subtree loads, which arms the timer (or marks the visit resolved with no timer).
 */
function commit(state: PlayerState): PlayerState {
  return { ...state, timeout: null, timeoutResolved: false };
}

function applyAction(state: PlayerState, action: ParsedAction, ctx: PlayerContext): StepResult {
  if (action.kind === "back") {
    return { state: commit(goBack(state)), effects: [] };
  }
  if (action.kind === "close") {
    if (state.overlays.length === 0) return { state, effects: [] };
    return { state: commit(closeTopOverlay(state)), effects: [] };
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
    return { state: commit({ ...state, overlays }), effects: [] };
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
    return { state: commit({ ...state, overlays }), effects: [] };
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
  // G5 r2: navigation replaces the whole stage, Figma-style — a NAVIGATE fired from inside an
  // open overlay (the sheet's "View cart") must dismiss the overlays along with it.
  return { state: commit({ ...state, stack, overlays: [], transition }), effects: [] };
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
        timeoutResolved: false,
      };
      return { state: commit(started), effects: [] };
    }
    case "interaction":
      return applyAction(state, event.action, ctx);
    case "toolbar_back":
      return { state: commit(goBack(state)), effects: [] };
    case "toolbar_restart": {
      if (!state.startFrameId) return { state, effects: [] };
      const restarted: PlayerState = {
        ...state,
        stack: [state.startFrameId],
        overlays: [],
        transition: null,
        timeout: null,
        timeoutResolved: false,
      };
      return { state: commit(restarted), effects: [] };
    }
    case "overlay_dismiss": {
      const top = state.overlays[state.overlays.length - 1];
      if (!top || !top.settings.closeOnClickOutside) return { state, effects: [] };
      return { state: commit(closeTopOverlay(state)), effects: [] };
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
    case "frame_ready": {
      if (event.frameId !== currentFrameId(state) || state.transition) {
        return { state, effects: [] };
      }
      const pending = timeoutFor(state, ctx);
      // Idempotent by value: re-firing with the same answer leaves the state (and the view's
      // timer) untouched. A re-fire once interactions arrive after the visit resolved replaces
      // the empty arm with the real one — the timer starts when the frame's data is on hand.
      if (state.timeoutResolved && sameArm(state.timeout, pending)) {
        return { state, effects: [] };
      }
      return {
        state: { ...state, timeout: pending, timeoutResolved: true },
        effects: [],
      };
    }
    case "transition_complete":
      return { state: { ...state, transition: null }, effects: [] };
  }
}
