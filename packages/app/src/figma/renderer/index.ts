// The JAgentDesk Figma renderer (spec 32.5.1, contract in ./types.ts). Pure TypeScript: it draws
// Figma REST node JSON (`geometry=paths`) onto any Canvas2D-compatible context, fetches nothing,
// and reports everything it could not draw (missing images/fonts/fallback rasters) through
// `options.onMissing`. W10's canvas viewer and W1's prototype player own the context and cache.
import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import { captureCamera, drawTree, type DrawState } from "./nodes";
import { hitTest } from "./hittest";
import { unsupportedChildFeatures, unsupportedFeatures } from "./unsupported";
import { MissingSink } from "./missing";
import type { FigmaCanvasContext, FigmaRenderOptions, FigmaRenderer } from "./types";

export function createFigmaRenderer(): FigmaRenderer {
  return {
    draw(ctx: FigmaCanvasContext, root: FigmaNode, options: FigmaRenderOptions): void {
      const scale = Number.isFinite(options.scale) && options.scale > 0 ? options.scale : 1;
      const missing = new MissingSink();
      const state: DrawState = { ctx, options, missing, scale, camera: captureCamera(ctx) };
      drawTree(state, root);
      if (!missing.empty && options.onMissing) options.onMissing(missing.report());
    },
    unsupportedFeatures(node: FigmaNode): string[] {
      return [...unsupportedFeatures(node), ...unsupportedChildFeatures(node)];
    },
    hitTest(root: FigmaNode, point: { x: number; y: number }): FigmaNode | null {
      return hitTest(root, point);
    },
  };
}

export type { FigmaCanvasContext, FigmaRenderOptions, FigmaRenderer } from "./types";
