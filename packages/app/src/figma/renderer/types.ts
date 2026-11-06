import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import type { MissingReport } from "./missing";

// Contract of the JAgentDesk Figma renderer (spec 32.5.1), owned by work package W9 and used by the
// canvas viewer (W10) and the prototype player (W1). It draws Figma REST node JSON
// (`geometry=paths`) onto a Canvas 2D context (web/desktop; a Skia adapter implements the same
// `FigmaCanvasContext` subset on mobile). It never fetches: images and fonts come from callbacks.

/** The subset of CanvasRenderingContext2D the renderer uses (implemented by Skia on mobile). */
export type FigmaCanvasContext = CanvasRenderingContext2D;

/**
 * Why a node needs a fallback raster, decided from node data BEFORE the getter is invoked
 * (queueing the wrong-rung asset request is a side effect outside this package, and the
 * missing-only report arrives too late to prevent it). `backgroundBlur: true` marks a
 * backdrop-specific request — the node carries a VISIBLE BACKGROUND_BLUR — so the asset
 * consumer (W10) serves the blurred-behind export capped at rung 2, never a full-detail
 * rung-4 export (ADR-0042). Ordinary fallbacks keep the two-argument call; legacy callbacks
 * ignore the extra optional parameter.
 */
export interface FigmaFallbackHint {
  readonly backgroundBlur?: boolean;
}

export interface FigmaRenderOptions {
  /**
   * Device pixels per Figma unit (zoom × devicePixelRatio), used only for what the context
   * transform cannot carry (shadow offsets, blur filters). Zoom and pan live on the context
   * transform itself: `draw` composes every node transform with the caller's current transform.
   */
  scale: number;
  /** Figma-space rectangle that is visible; nodes outside it are skipped. */
  viewport?: { x: number; y: number; width: number; height: number };
  /** Decoded image for an `imageRef` (image fills), or null while it loads. */
  imageForRef: (imageRef: string) => CanvasImageSource | null;
  /**
   * Decoded fallback raster of a node the renderer cannot draw (see `unsupportedFeatures`;
   * also used for TEXT nodes whose required family/style fails `fontAvailable`). `nodeType` is
   * the node's Figma type so the caller can route TEXT ids to the Figma-exported SVG outline
   * bytes and everything else to PNG (ADR-0042); pre-ADR callers ignore the parameter.
   */
  fallbackForNode: (
    nodeId: string,
    nodeType?: string,
    hint?: FigmaFallbackHint,
  ) => CanvasImageSource | null;
  /**
   * True only on W10's new-quality path: TEXT fallback bytes were exported with
   * `use_absolute_bounds=true` and map 1:1 onto `absoluteBoundingBox`. Default false keeps the
   * legacy crop contract: every fallback (and TEXT bytes requested without the flag) maps onto
   * `absoluteRenderBounds`, because Figma's default export is cropped to the rendered ink
   * (ADR-0042 G2: a 44×44 shadow frame exports 2×72×72, and text exports to its ink box).
   */
  fallbackTextUsesAbsoluteBounds?: boolean;
  /** True when the font face is loaded and usable by the context. */
  fontAvailable: (family: string, style: string) => boolean;
  /** Called with nodes that need a fallback raster or a font, so the caller can fetch them. */
  onMissing?: (missing: MissingReport) => void;
  /** Per-node property overrides (pending edits 32.6.1, smart-animate frames 32.5.3). */
  overrides?: Record<string, Partial<FigmaNode>>;
}

export interface FigmaRenderer {
  /** Draws `root` (a frame/page subtree) with its absoluteBoundingBox at Figma coordinates. */
  draw(ctx: FigmaCanvasContext, root: FigmaNode, options: FigmaRenderOptions): void;
  /** Feature names of `node` this renderer cannot draw faithfully (drives fallback rasters). */
  unsupportedFeatures(node: FigmaNode): string[];
  /** Topmost visible node under a Figma-space point, for selection and prototype hotspots. */
  hitTest(root: FigmaNode, point: { x: number; y: number }): FigmaNode | null;
}
