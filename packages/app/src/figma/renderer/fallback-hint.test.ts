// FigmaFallbackHint semantics (ADR-0042 backdrop rungs, root-ordered): drawFallback passes
// { backgroundBlur: true } ONLY for nodes carrying a VISIBLE BACKGROUND_BLUR, and decides it
// from node data BEFORE invoking the getter — the call itself queues the asset request, so a
// post-call report could not un-queue a wrong rung. Ordinary fallbacks keep the literal
// two-argument call so pre-hint exact-arity mocks stay untouched, and the missing report
// gains no hint field. Real effect data drives the route; no product-side color/hint guess.
import { describe, expect, it } from "vitest";
import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import { createFigmaRenderer } from "./index";
import { fakeImage, RecordingContext } from "./__fixtures__/recording-context";
import type { FigmaFallbackHint, FigmaRenderOptions } from "./types";

interface FallbackCall {
  id: string;
  nodeType?: string;
  argCount: number;
  hint?: FigmaFallbackHint;
}

function drawWithCapture(
  node: FigmaNode,
  overrides: Partial<FigmaRenderOptions> = {},
): {
  calls: FallbackCall[];
  ops: unknown[][];
} {
  const calls: FallbackCall[] = [];
  const ctx = new RecordingContext();
  createFigmaRenderer().draw(ctx as unknown as CanvasRenderingContext2D, node, {
    scale: 2,
    imageForRef: (ref) => fakeImage(ref) as unknown as CanvasImageSource,
    fallbackForNode: function (nodeId, nodeType, hint) {
      // eslint-disable-next-line prefer-rest-params
      calls.push({ id: nodeId, nodeType, argCount: arguments.length, hint });
      return fakeImage(`raster:${nodeId}`) as unknown as CanvasImageSource;
    },
    fontAvailable: () => true,
    ...overrides,
  });
  return { calls, ops: ctx.ops };
}

function backdropNode(extra: Record<string, unknown> = {}): FigmaNode {
  return {
    id: "9:1",
    name: "scrim",
    type: "FRAME",
    absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 50 },
    relativeTransform: [
      [1, 0, 0],
      [0, 1, 0],
    ],
    // PATTERN is not a supported paint type: the node is routed to the per-node fallback.
    fills: [{ type: "PATTERN" }],
    strokes: [],
    ...extra,
  } as unknown as FigmaNode;
}

function textNode(extra: Record<string, unknown> = {}): FigmaNode {
  return {
    id: "9:2",
    name: "label",
    type: "TEXT",
    absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 40 },
    relativeTransform: [
      [1, 0, 0],
      [0, 1, 0],
    ],
    characters: "Sign in",
    style: { fontFamily: "SF Pro", fontStyle: "Regular", fontSize: 16 },
    characterStyleOverrides: [],
    styleOverrideTable: {},
    fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }],
    strokes: [],
    ...extra,
  } as unknown as FigmaNode;
}

const BLUR = { type: "BACKGROUND_BLUR", radius: 4 };

describe("fallbackForNode backdrop hint (ADR-0042)", () => {
  it("supplies backgroundBlur:true for a VISIBLE BACKGROUND_BLUR, decided before the call", () => {
    const { calls, ops } = drawWithCapture(backdropNode({ effects: [{ ...BLUR, visible: true }] }));
    expect(calls).toHaveLength(1);
    expect(calls[0].argCount).toBe(3); // the hint argument exists...
    expect(calls[0].hint).toEqual({ backgroundBlur: true }); // ...and is the backdrop mark.
    expect(
      ops.some((op) => op[0] === "drawImage"),
      "the raster was drawn",
    ).toBe(true);
  });

  it("treats an effects entry without a visible flag as visible (real default)", () => {
    const { calls } = drawWithCapture(backdropNode({ effects: [BLUR] }));
    expect(calls[0].argCount).toBe(3);
    expect(calls[0].hint).toEqual({ backgroundBlur: true });
  });

  it("keeps the two-argument call for a HIDDEN BACKGROUND_BLUR on an ordinary fallback", () => {
    const { calls } = drawWithCapture(backdropNode({ effects: [{ ...BLUR, visible: false }] }));
    expect(calls).toHaveLength(1);
    expect(calls[0].argCount).toBe(2); // no third argument was passed at all
    expect(calls[0].hint).toBeUndefined();
  });

  it("keeps the two-argument call when the node has NO effects", () => {
    const { calls } = drawWithCapture(backdropNode());
    expect(calls).toHaveLength(1);
    expect(calls[0].argCount).toBe(2);
    expect(calls[0].hint).toBeUndefined();
  });

  it("routes TEXT fallback through the same hint contract: nodeType TEXT, no hint without blur", () => {
    const { calls } = drawWithCapture(textNode(), { fontAvailable: () => false });
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe("9:2");
    expect(calls[0].nodeType).toBe("TEXT");
    expect(calls[0].argCount).toBe(2);
  });

  it("marks TEXT fallback with backgroundBlur:true when the node also carries a visible blur", () => {
    const { calls } = drawWithCapture(textNode({ effects: [{ ...BLUR, visible: true }] }), {
      fontAvailable: () => false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].nodeType).toBe("TEXT");
    expect(calls[0].argCount).toBe(3);
    expect(calls[0].hint).toEqual({ backgroundBlur: true });
  });
});
