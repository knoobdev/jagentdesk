// Shared drawing helpers for the renderer tests: fixture loading, deterministic options and the
// recording draw. Lives under __fixtures__ so importing it never re-registers a test suite.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import { createFigmaRenderer } from "../index";
import { fakeImage, RecordingContext } from "./recording-context";
import type { FigmaRenderOptions } from "../types";

const here = path.dirname(fileURLToPath(import.meta.url));

export function loadNode(name: string): FigmaNode {
  return JSON.parse(readFileSync(path.join(here, "nodes", `${name}.json`), "utf8")) as FigmaNode;
}

/** Deterministic options: every image, fallback raster and font resolves. */
export function defaultRenderOptions(overrides?: Partial<FigmaRenderOptions>): FigmaRenderOptions {
  return {
    scale: 2,
    imageForRef: (imageRef) => fakeImage(imageRef, 120, 80) as unknown as CanvasImageSource,
    fallbackForNode: (nodeId) => fakeImage(`raster:${nodeId}`) as unknown as CanvasImageSource,
    fontAvailable: () => true,
    ...overrides,
  };
}

/**
 * Draw a fixture. When `camera` is given it is installed as the caller's CTM before draw() runs
 * (the first recorded op is that setTransform, so callers of the returned stream skip index 0).
 */
export function recordedOps(
  node: FigmaNode,
  options?: Partial<FigmaRenderOptions>,
  camera?: { a: number; b: number; c: number; d: number; e: number; f: number },
): unknown[][] {
  const ctx = new RecordingContext();
  if (camera) {
    ctx.setTransform(camera.a, camera.b, camera.c, camera.d, camera.e, camera.f);
  }
  createFigmaRenderer().draw(
    ctx as unknown as CanvasRenderingContext2D,
    node,
    defaultRenderOptions(options),
  );
  return ctx.ops;
}

/** The six-tuples of every setTransform the renderer emitted, in draw order. */
export function setTransformOps(ops: unknown[][]): number[][] {
  return ops
    .filter((op) => op[0] === "setTransform")
    .map((op) => (op as unknown[]).slice(1) as number[]);
}
