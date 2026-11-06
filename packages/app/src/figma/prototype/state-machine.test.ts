import { describe, expect, it } from "vitest";
import {
  baseFrameIdFor,
  currentFrameId,
  DEFAULT_OVERLAY_SETTINGS,
  emptyPlayerState,
  parseOverlayPosition,
  step,
  visibleFrameIds,
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

  it("arrival clears the timer; frame_ready arms it once the data is on hand", () => {
    const timeout = timeoutCtx(2_000, navigate("Next"));
    const started = step(emptyPlayerState(), { type: "start", frameId: "A" }, timeout).state;
    // ADR-0037: the AFTER_TIMEOUT must not start before the frame's data has arrived.
    expect(started.timeout).toBeNull();
    expect(started.timeoutResolved).toBe(false);

    const armed = step(started, { type: "frame_ready", frameId: "A" }, timeout);
    expect(armed.state.timeout).toEqual({ frameId: "A", delayMs: 2_000 });
    expect(armed.state.timeoutResolved).toBe(true);

    // Clock ticks and re-fetches replay the effect — a resolved visit never re-arms.
    expect(step(armed.state, { type: "frame_ready", frameId: "A" }, timeout).state).toBe(
      armed.state,
    );
  });

  it("frame_ready resolves a frame without a timer exactly once", () => {
    const context = ctx();
    const started = step(emptyPlayerState(), { type: "start", frameId: "A" }, context).state;
    const ready = step(started, { type: "frame_ready", frameId: "A" }, context);
    expect(ready.state.timeout).toBeNull();
    expect(ready.state.timeoutResolved).toBe(true);
    expect(step(ready.state, { type: "frame_ready", frameId: "A" }, context).state).toBe(
      ready.state,
    );
  });

  it("frame_ready ignores a frame that is not on stage", () => {
    const timeout = timeoutCtx(2_000, navigate("Next"));
    const started = step(emptyPlayerState(), { type: "start", frameId: "A" }, timeout).state;
    expect(step(started, { type: "frame_ready", frameId: "Z" }, timeout).state).toBe(started);
  });

  it("frame_ready waits through a transition; the target arms after completion", () => {
    const onB = { delayMs: 500, action: navigate("C") };
    const context = ctx({ afterTimeoutFor: (frameId) => (frameId === "B" ? onB : null) });
    let state = step(emptyPlayerState(), { type: "start", frameId: "A" }, context).state;
    state = step(
      state,
      {
        type: "interaction",
        action: {
          kind: "navigate",
          destinationId: "B",
          transition: { type: "DISSOLVE", direction: null, durationMs: 300, easing: "LINEAR" },
        },
      },
      context,
    ).state;
    expect(state.transition).not.toBeNull();
    // Data landing mid-animation must not pre-arm, and must not fire behind the transition.
    expect(step(state, { type: "frame_ready", frameId: "B" }, context).state).toBe(state);
    state = step(state, { type: "transition_complete" }, context).state;
    const armed = step(state, { type: "frame_ready", frameId: "B" }, context);
    expect(armed.state.timeout).toEqual({ frameId: "B", delayMs: 500 });
  });

  it("re-entry re-arms the revisited frame's timer", () => {
    const onA = { delayMs: 500, action: navigate("B") };
    const context = ctx({ afterTimeoutFor: (frameId) => (frameId === "A" ? onA : null) });
    let state = step(emptyPlayerState(), { type: "start", frameId: "A" }, context).state;
    state = step(state, { type: "frame_ready", frameId: "A" }, context).state;
    expect(state.timeout).not.toBeNull();
    // Back on the same frame (stack of one) clears the fired timer; the next ready arms it again.
    state = step(state, { type: "toolbar_back" }, context).state;
    expect(state.timeout).toBeNull();
    expect(state.timeoutResolved).toBe(false);
    const rearmed = step(state, { type: "frame_ready", frameId: "A" }, context);
    expect(rearmed.state.timeout).toEqual({ frameId: "A", delayMs: 500 });
  });

  it("restart clears the timer until the restarted frame reports ready", () => {
    const timeout = timeoutCtx(2_000, navigate("Next"));
    let state = step(emptyPlayerState(), { type: "start", frameId: "A" }, timeout).state;
    state = step(state, { type: "frame_ready", frameId: "A" }, timeout).state;
    state = step(state, { type: "toolbar_restart" }, timeout).state;
    expect(state.timeout).toBeNull();
    expect(state.timeoutResolved).toBe(false);
    const armed = step(state, { type: "frame_ready", frameId: "A" }, timeout);
    expect(armed.state.timeout).toEqual({ frameId: "A", delayMs: 2_000 });
  });

  it("visibleFrameIds covers the stage only — base, overlays, transition pair — not Back history", () => {
    let state = step(emptyPlayerState(), { type: "start", frameId: "A" }, ctx()).state;
    state = step(state, { type: "interaction", action: navigate("B") }, ctx()).state;
    state = step(state, { type: "interaction", action: navigate("C") }, ctx()).state;
    state = step(
      state,
      { type: "interaction", action: { kind: "overlay", destinationId: "S" } },
      ctx(),
    ).state;
    expect(state.stack).toEqual(["A", "B", "C"]);
    // A and B live only as ids in the Back stack; their trees are not observed.
    expect(new Set(visibleFrameIds(state))).toEqual(new Set(["C", "S"]));

    const withTransition = step(
      state,
      {
        type: "interaction",
        action: {
          kind: "navigate",
          destinationId: "D",
          transition: { type: "PUSH", direction: "LEFT", durationMs: 200, easing: "LINEAR" },
        },
      },
      ctx({ now: 9_000 }),
    ).state;
    // A NAVIGATE fired from the sheet transitions the sheet itself (currentFrameId is the top
    // overlay), so the pair is S→D; C and the stack stay ids only.
    expect(new Set(visibleFrameIds(withTransition))).toEqual(new Set(["D", "S"]));
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
    // The timer arms only once the frame's data is on hand (ADR-0037).
    state = step(state, { type: "frame_ready", frameId: "A" }, context).state;
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

  it("keeps the frame UNDER the overlays as the stage's base (G5 bug 2)", () => {
    let state = startedState();
    expect(baseFrameIdFor(state)).toBe("A");
    state = step(
      state,
      { type: "interaction", action: { kind: "overlay", destinationId: "Sheet" } },
      ctx(),
    ).state;
    // The top overlay is what the machine considers active — and what the old PlayerStage drew
    // as the base canvas, hiding the frame behind the sheet entirely.
    expect(currentFrameId(state)).toBe("Sheet");
    expect(baseFrameIdFor(state)).toBe("A");
    // Stacking a second overlay still keeps the top-level frame as the base.
    state = step(
      state,
      { type: "interaction", action: { kind: "overlay", destinationId: "Sheet2" } },
      ctx(),
    ).state;
    expect(baseFrameIdFor(state)).toBe("A");
    // Closing everything leaves base and current frame identical.
    state = step(state, { type: "overlay_dismiss" }, ctx()).state;
    state = step(state, { type: "overlay_dismiss" }, ctx()).state;
    expect(baseFrameIdFor(state)).toBe(currentFrameId(state));
  });

  it("a hotspot click inside an open overlay runs its action (G5 r2)", () => {
    // "View cart" → NAVIGATE: navigation replaces the whole stage, Figma-style, so the sheet
    // must be gone and the destination current — not stacked under a lingering overlay.
    let state = startedState();
    state = step(
      state,
      { type: "interaction", action: { kind: "overlay", destinationId: "Sheet" } },
      ctx(),
    ).state;
    state = step(
      state,
      {
        type: "interaction",
        action: { kind: "navigate", destinationId: "Cart", transition: null },
      },
      ctx(),
    ).state;
    expect(currentFrameId(state)).toBe("Cart");
    expect(state.stack).toEqual(["A", "Cart"]);
    expect(state.overlays).toEqual([]);

    // "Keep shopping" → CLOSE: pops only the sheet, back to the frame under it.
    let withSheet = startedState();
    withSheet = step(
      withSheet,
      { type: "interaction", action: { kind: "overlay", destinationId: "Sheet" } },
      ctx(),
    ).state;
    withSheet = step(withSheet, { type: "interaction", action: { kind: "close" } }, ctx()).state;
    expect(currentFrameId(withSheet)).toBe("A");
    expect(withSheet.overlays).toHaveLength(0);
  });
});
