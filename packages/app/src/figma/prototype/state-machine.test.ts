import { describe, expect, it } from "vitest";
import {
  currentFrameId,
  DEFAULT_OVERLAY_SETTINGS,
  emptyPlayerState,
  parseOverlayPosition,
  step,
  type PlayerContext,
  type PlayerState,
} from "./state-machine";
import type { ParsedAction } from "./interactions";
import type { OverlaySettings } from "./state-machine";

function ctx(options: Partial<PlayerContext> & { now?: number } = {}): PlayerContext {
  let clock = options.now ?? 1_000;
  const timeouts = new Map<string, { delayMs: number; action: ParsedAction }>();
  const overlays = new Map<string, OverlaySettings>();
  return {
    now_ms: () => {
      clock += 1;
      return clock;
    },
    overlaySettingsFor: (frameId) =>
      overlays.get(frameId) ?? options.overlaySettingsFor?.(frameId) ?? DEFAULT_OVERLAY_SETTINGS,
    afterTimeoutFor: (frameId) =>
      timeouts.get(frameId) ?? options.afterTimeoutFor?.(frameId) ?? null,
  };
}

function timeoutCtx(delayMs: number, action: ParsedAction): PlayerContext {
  return ctx({ afterTimeoutFor: () => ({ delayMs, action }) });
}

const navigate = (destinationId: string): ParsedAction => ({
  kind: "navigate",
  destinationId,
  transition: null,
});

function startedState(): PlayerState {
  const { state } = step(emptyPlayerState(), { type: "start", frameId: "A" }, ctx());
  return state;
}

describe("player state machine", () => {
  it("starts a flow with one frame on the stack", () => {
    const state = startedState();
    expect(state.startFrameId).toBe("A");
    expect(currentFrameId(state)).toBe("A");
    expect(state.overlays).toEqual([]);
  });

  it("navigate pushes the destination and keeps history", () => {
    let state = startedState();
    state = step(state, { type: "interaction", action: navigate("B") }, ctx()).state;
    expect(currentFrameId(state)).toBe("B");
    expect(state.stack).toEqual(["A", "B"]);
  });

  it("navigate with a transition starts it, and transition_complete ends it", () => {
    let state = startedState();
    const result = step(
      state,
      {
        type: "interaction",
        action: {
          kind: "navigate",
          destinationId: "B",
          transition: { type: "PUSH", direction: "LEFT", durationMs: 200, easing: "LINEAR" },
        },
      },
      ctx({ now: 500 }),
    );
    state = result.state;
    expect(state.transition).toMatchObject({
      fromFrameId: "A",
      toFrameId: "B",
      startedAt_ms: 501,
    });
    expect(state.transition?.plan.type).toBe("PUSH");
    const done = step(state, { type: "transition_complete" }, ctx());
    expect(done.state.transition).toBeNull();
  });

  it("back walks the stack and stops on the first frame", () => {
    let state = startedState();
    state = step(state, { type: "interaction", action: navigate("B") }, ctx()).state;
    state = step(state, { type: "toolbar_back" }, ctx()).state;
    expect(currentFrameId(state)).toBe("A");
    state = step(state, { type: "toolbar_back" }, ctx()).state;
    expect(currentFrameId(state)).toBe("A");
  });

  it("overlay opens above the current frame, swap replaces it, close returns to the frame", () => {
    let state = startedState();
    state = step(
      state,
      { type: "interaction", action: { kind: "overlay", destinationId: "Sheet" } },
      ctx(),
    ).state;
    expect(currentFrameId(state)).toBe("Sheet");
    expect(state.overlays).toHaveLength(1);
    expect(state.stack).toEqual(["A"]);

    state = step(
      state,
      { type: "interaction", action: { kind: "swap", destinationId: "Sheet2" } },
      ctx(),
    ).state;
    expect(currentFrameId(state)).toBe("Sheet2");
    expect(state.overlays).toHaveLength(1);

    state = step(state, { type: "interaction", action: { kind: "close" } }, ctx()).state;
    expect(currentFrameId(state)).toBe("A");
    expect(state.overlays).toHaveLength(0);
  });

  it("swap with no overlay open pushes one like OVERLAY", () => {
    const state = step(
      startedState(),
      { type: "interaction", action: { kind: "swap", destinationId: "X" } },
      ctx(),
    ).state;
    expect(state.overlays).toEqual([{ frameId: "X", settings: DEFAULT_OVERLAY_SETTINGS }]);
  });

  it("back closes the topmost overlay before walking the stack", () => {
    let state = startedState();
    state = step(
      state,
      { type: "interaction", action: { kind: "overlay", destinationId: "S1" } },
      ctx(),
    ).state;
    state = step(
      state,
      { type: "interaction", action: { kind: "overlay", destinationId: "S2" } },
      ctx(),
    ).state;
    state = step(state, { type: "toolbar_back" }, ctx()).state;
    expect(currentFrameId(state)).toBe("S1");
    state = step(state, { type: "toolbar_back" }, ctx()).state;
    expect(currentFrameId(state)).toBe("A");
  });

  it("dismiss only closes overlays that opt into close-on-outside-click", () => {
    const noDismiss = ctx({
      overlaySettingsFor: () => ({ ...DEFAULT_OVERLAY_SETTINGS, closeOnClickOutside: false }),
    });
    const kept = step(startedState(), { type: "overlay_dismiss" }, noDismiss);
    expect(kept.state.overlays).toHaveLength(0);

    let state = startedState();
    state = step(
      state,
      { type: "interaction", action: { kind: "overlay", destinationId: "S" } },
      noDismiss,
    ).state;
    expect(step(state, { type: "overlay_dismiss" }, noDismiss).state.overlays).toHaveLength(1);
    expect(step(state, { type: "overlay_dismiss" }, ctx()).state.overlays).toHaveLength(1);

    let closable = startedState();
    closable = step(
      closable,
      { type: "interaction", action: { kind: "overlay", destinationId: "S" } },
      ctx(),
    ).state;
    expect(step(closable, { type: "overlay_dismiss" }, ctx()).state.overlays).toHaveLength(0);
  });

  it("url and scroll_to leave the state alone and emit effects", () => {
    const state = startedState();
    const url = step(
      state,
      { type: "interaction", action: { kind: "url", url: "https://example.test" } },
      ctx(),
    );
    expect(url.state).toBe(state);
    expect(url.effects).toEqual([{ kind: "open_url", url: "https://example.test" }]);

    const scroll = step(
      state,
      { type: "interaction", action: { kind: "scroll_to", destinationId: "n1" } },
      ctx(),
    );
    expect(scroll.state).toBe(state);
    expect(scroll.effects).toEqual([{ kind: "scroll_to", frameId: "A", targetId: "n1" }]);
  });

  it("arming a flow re-arms the frame's after-timeout", () => {
    const timeout = timeoutCtx(2_000, navigate("Next"));
    const state = step(emptyPlayerState(), { type: "start", frameId: "A" }, timeout).state;
    expect(state.timeout).toEqual({ frameId: "A", delayMs: 2_000 });
  });

  it("timeout_fire applies the pending action and moves on", () => {
    const onA = { delayMs: 500, action: navigate("B") };
    let fired = false;
    const context = ctx({
      afterTimeoutFor: (frameId) => {
        if (frameId !== "A" || fired) return null;
        return onA;
      },
    });
    let state = step(emptyPlayerState(), { type: "start", frameId: "A" }, context).state;
    const result = step(state, { type: "timeout_fire" }, context);
    fired = true;
    state = result.state;
    expect(currentFrameId(state)).toBe("B");
    expect(state.timeout).toBeNull();
  });

  it("timeout_fire ignores stale timers from another frame", () => {
    const state = startedState();
    const withTimer: PlayerState = { ...state, timeout: { frameId: "A", delayMs: 100 } };
    const result = step({ ...withTimer, stack: ["Z"] }, { type: "timeout_fire" }, ctx());
    expect(currentFrameId(result.state)).toBe("Z");
    expect(result.state.timeout).toBeNull();
    expect(result.state.stack).toEqual(["Z"]);
  });

  it("restart returns to the flow start and clears overlays and history", () => {
    let state = startedState();
    state = step(state, { type: "interaction", action: navigate("B") }, ctx()).state;
    state = step(
      state,
      { type: "interaction", action: { kind: "overlay", destinationId: "S" } },
      ctx(),
    ).state;
    state = step(state, { type: "toolbar_restart" }, ctx()).state;
    expect(currentFrameId(state)).toBe("A");
    expect(state.stack).toEqual(["A"]);
    expect(state.overlays).toHaveLength(0);
  });

  it("parseOverlayPosition narrows the wire string, MANUAL and unknown center", () => {
    expect(parseOverlayPosition("BOTTOM_RIGHT")).toBe("BOTTOM_RIGHT");
    expect(parseOverlayPosition("MANUAL")).toBe("CENTER");
    expect(parseOverlayPosition(undefined)).toBe("CENTER");
  });
});
