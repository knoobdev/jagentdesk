// Camera composition (spec 32.5.1): the caller owns the context transform — zoom, pan and device
// pixels are already on it when draw() runs. Every node transform the renderer emits must compose
// with that camera, never replace it: the old absolute setTransform discarded the pan offset, so
// the drawing stayed pinned while the selection box (drawn through the same camera transform)
// moved. Each test installs a camera on the fake context and asserts the exact six-tuples the
// renderer would hand to the browser.
import { describe, expect, it } from "vitest";
import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import { RecordingContext } from "./__fixtures__/recording-context";
import { defaultRenderOptions, loadNode, recordedOps } from "./__fixtures__/render-harness";
import { createFigmaRenderer } from "./index";
import { identity, multiply, scale, translate, type RenderMatrix } from "./matrix";

const PAN_ZOOM = multiply(translate(150, -80), scale(2.5, 2.5));
const DEEP_PAN = multiply(translate(-320, 45), scale(0.4, 0.4));

function asSix(m: RenderMatrix): number[] {
  return [m.a, m.b, m.c, m.d, m.e, m.f];
}

/** setTransform six-tuples the renderer emitted; index 0 is the caller's own installed camera. */
function transforms(node: FigmaNode, camera: RenderMatrix): number[][] {
  const ops = recordedOps(node, undefined, camera);
  return ops
    .slice(1)
    .filter((op) => op[0] === "setTransform")
    .map((op) => (op as unknown[]).slice(1) as number[]);
}

describe("renderer composes node transforms with the caller's camera", () => {
  it("restores the caller's camera as the per-subtree baseline", () => {
    const ops = transforms(loadNode("rectangle-solid"), PAN_ZOOM);
    expect(ops.length).toBeGreaterThan(0);
    // Regression guard: the old code baselined at `state.scale`, ignoring the caller's CTM.
    expect(ops[0]).toEqual(asSix(PAN_ZOOM));
  });

  it("composes the camera with the node matrix", () => {
    const ops = transforms(loadNode("rectangle-solid"), PAN_ZOOM);
    const node: RenderMatrix = { a: 1, b: 0, c: 0, d: 1, e: 10, f: 20 };
    // Old code recorded the bare node matrix times scale — no pan, no zoom from the caller.
    expect(ops[1]).toEqual(asSix(multiply(PAN_ZOOM, node)));
  });

  it("two cameras differ exactly by the camera transform, never collapse to one stream", () => {
    const node: RenderMatrix = { a: 1, b: 0, c: 0, d: 1, e: 10, f: 20 };
    const underPan = transforms(loadNode("rectangle-solid"), PAN_ZOOM);
    const underDeep = transforms(loadNode("rectangle-solid"), DEEP_PAN);
    expect(underPan.length).toBe(underDeep.length);
    expect(underPan.length).toBeGreaterThan(1);
    // Regression guard: discarding the camera made both streams identical.
    expect(underDeep).not.toEqual(underPan);
    expect(underPan).toEqual([asSix(PAN_ZOOM), asSix(multiply(PAN_ZOOM, node))]);
    expect(underDeep).toEqual([asSix(DEEP_PAN), asSix(multiply(DEEP_PAN, node))]);
  });

  it("composes the camera into fallback raster placement too", () => {
    const ops = transforms(loadNode("background-blur"), PAN_ZOOM);
    // 9:4 is unsupported (BACKGROUND_BLUR) → drawFallback paints its raster at the absolute box.
    const box = { x: 10, y: 10 };
    const expected = multiply(PAN_ZOOM, translate(box.x, box.y));
    expect(ops[ops.length - 1]).toEqual(asSix(expected));
  });

  it("places REST children by absolute position under the camera", () => {
    // 40:3 sits at absolute (170, 310): the node matrix must carry that, not the parent-relative
    // (10, 40) translation, or the child lands back inside the group's corner.
    const ops = transforms(loadNode("rest-frame-group-tree"), PAN_ZOOM);
    const placed = multiply(PAN_ZOOM, translate(170, 310));
    expect(ops).toContainEqual(asSix(placed));
    expect(ops).not.toContainEqual(
      asSix(multiply(PAN_ZOOM, multiply(translate(10, 40), translate(170, 310)))),
    );
  });

  it("draws at 1:1 for a context that cannot report its transform", () => {
    const ctx = new RecordingContext();
    (ctx as { getTransform?: unknown }).getTransform = undefined;
    recordedOpsNoCamera(ctx, loadNode("rectangle-solid"));
    const ops = ctx.ops
      .filter((op) => op[0] === "setTransform")
      .map((op) => (op as unknown[]).slice(1) as number[]);
    expect(ops[0]).toEqual(asSix(identity()));
    expect(ops[1]).toEqual([1, 0, 0, 1, 10, 20]);
  });

  it("treats a non-finite current transform as identity", () => {
    const ctx = new RecordingContext();
    ctx.setTransform(Number.NaN, 0, 0, Number.NaN, Number.NaN, Number.NaN);
    recordedOpsNoCamera(ctx, loadNode("rectangle-solid"));
    const ops = ctx.ops
      .filter((op) => op[0] === "setTransform")
      .map((op) => (op as unknown[]).slice(1) as number[]);
    // ops[0] is the caller's own NaN setTransform; the renderer baselines at identity, not at it.
    expect(ops[1]).toEqual(asSix(identity()));
    expect(ops[2]).toEqual([1, 0, 0, 1, 10, 20]);
  });
});

function recordedOpsNoCamera(ctx: RecordingContext, node: FigmaNode): void {
  createFigmaRenderer().draw(
    ctx as unknown as CanvasRenderingContext2D,
    node,
    defaultRenderOptions(),
  );
}
