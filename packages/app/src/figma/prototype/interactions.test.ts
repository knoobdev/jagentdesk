import { describe, expect, it } from "vitest";
import {
  afterTimeoutForNode,
  indexInteractions,
  interactionsForNode,
  parseAction,
  parseInteraction,
} from "./interactions";
import { interaction, NAVIGATE_B } from "./test-support/frames";

describe("parseAction", () => {
  it("maps navigation kinds onto typed actions", () => {
    expect(parseAction(NAVIGATE_B)).toEqual({
      kind: "navigate",
      destinationId: "2:1",
      transition: null,
    });
    expect(parseAction({ type: "NODE", navigation: "OVERLAY", destinationId: "o" })).toEqual({
      kind: "overlay",
      destinationId: "o",
    });
    expect(parseAction({ type: "NODE", navigation: "SWAP", destinationId: "s" })).toEqual({
      kind: "swap",
      destinationId: "s",
    });
    expect(parseAction({ type: "NODE", navigation: "SCROLL_TO", destinationId: "t" })).toEqual({
      kind: "scroll_to",
      destinationId: "t",
    });
  });

  it("plans the transition attached to a navigate", () => {
    const parsed = parseAction({
      type: "NODE",
      navigation: "NAVIGATE",
      destinationId: "2:1",
      transition: { type: "DISSOLVE", durationMs: 300, easing: "EASE_OUT" },
    });
    expect(parsed).toMatchObject({
      kind: "navigate",
      transition: { type: "DISSOLVE", durationMs: 300, easing: "EASE_OUT" },
    });
  });

  it("keeps back, close and url actions and ignores nonsense", () => {
    expect(parseAction({ type: "BACK" })).toEqual({ kind: "back" });
    expect(parseAction({ type: "CLOSE" })).toEqual({ kind: "close" });
    expect(parseAction({ type: "URL", url: "https://figma.com" })).toEqual({
      kind: "url",
      url: "https://figma.com",
    });
    expect(parseAction({ type: "URL" })).toEqual({ kind: "ignore" });
    expect(parseAction({ type: "NODE" })).toEqual({ kind: "ignore" });
    expect(parseAction({ type: "NAVIGATE_TO_THE_MOON" })).toEqual({ kind: "ignore" });
  });
});

describe("indexInteractions", () => {
  it("groups playable interactions per node and drops the rest", () => {
    const map = indexInteractions([
      interaction("10:2", { type: "ON_CLICK" }, NAVIGATE_B),
      interaction(
        "10:2",
        { type: "ON_HOVER" },
        { type: "NODE", navigation: "OVERLAY", destinationId: "h" },
      ),
      interaction("10:2", { type: "ON_DRAG" }, NAVIGATE_B),
      interaction("10:3", { type: "ON_PRESS" }, { type: "CLOSE" }),
      interaction("10:4", { type: "AFTER_TIMEOUT", delayMs: 800 }, NAVIGATE_B),
    ]);
    expect(interactionsForNode(map, "10:2").map((i) => i.trigger)).toEqual([
      "ON_CLICK",
      "ON_HOVER",
    ]);
    expect(interactionsForNode(map, "10:3")).toHaveLength(1);
    expect(interactionsForNode(map, "10:4")).toHaveLength(1);
    expect(interactionsForNode(map, "9:9")).toHaveLength(0);
  });

  it("parses triggers, delays and unknown trigger kinds", () => {
    expect(
      parseInteraction(interaction("10:4", { type: "AFTER_TIMEOUT", delayMs: 500 }, NAVIGATE_B)),
    ).toEqual({
      nodeId: "10:4",
      trigger: "AFTER_TIMEOUT",
      delayMs: 500,
      action: { kind: "navigate", destinationId: "2:1", transition: null },
    });
    expect(parseInteraction(interaction("x", { type: "ON_KEYPRESS" }, NAVIGATE_B)).trigger).toBe(
      "OTHER",
    );
    expect(
      parseInteraction(interaction("x", { type: "AFTER_TIMEOUT", delayMs: -3 }, NAVIGATE_B))
        .delayMs,
    ).toBe(0);
  });

  it("finds only AFTER_TIMEOUT entries in afterTimeoutForNode", () => {
    const map = indexInteractions([
      interaction("10:1", { type: "AFTER_TIMEOUT", delayMs: 1_200 }, { type: "CLOSE" }),
      interaction("10:1", { type: "ON_CLICK" }, NAVIGATE_B),
    ]);
    expect(afterTimeoutForNode(map, "10:1")).toEqual({ delayMs: 1_200, action: { kind: "close" } });
    expect(afterTimeoutForNode(map, "nope")).toBeNull();
  });
});
