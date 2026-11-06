import { useCallback, useEffect, useMemo, useRef } from "react";
import type { FigmaBytes } from "@jagentdesk/protocol/figma/rpc-schemas";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { isItalicStyle, weightForStyle } from "../font-style";
import { callFigma } from "./api";
import {
  ByteImageCache,
  FontCache,
  rasterNamespace,
  rasterRung,
  type DecodedImageLike,
  type RasterBounds,
  type RasterFormat,
} from "./assets";

// Asset plumbing for the canvas (spec 32.5.1): the renderer never fetches, so these caches are
// the fetch side. Image fills, fallback rasters / thumbnails and fonts all come back as base64
// bytes (32.8) and decode to DOM images / FontFace here. The DOM decoders live behind injectable
// factories so the caches and their tests never require a real DOM.
// ADR-0042 quality path (host capability + pinned version): TEXT fallbacks become Figma-exported
// outlined SVGs drawn at the absolute bounding box — crisp at any zoom, correct glyphs without
// the font — with one finite absolute-bounds PNG downgrade per node if the SVG fails; non-TEXT
// rasters ride an adaptive rung ceil(zoom × dpr) clamped 1..4 instead of the legacy fixed 2.
// Without the capability or the pin, every request is the exact pre-ADR-0042 scale-2 crop PNG.

export type ImageDecoder = (dataUrl: string) => DecodedImageLike | null;

const webDecode: ImageDecoder = (dataUrl) => {
  if (typeof document === "undefined") return null;
  const image = document.createElement("img") as unknown as DecodedImageLike;
  image.src = dataUrl;
  return image;
};

/**
 * Register bytes as a FontFace under the EXACT family the renderer asks for: text.ts sets
 * `ctx.font = ... "family"` with numeric weight/italic descriptors, so a face named
 * `"Inter Bold"` is a different family the canvas never matches. `isCurrent` retires the attempt
 * if the owner cleared OR the key was reconciled away (unobserved at endDraw) while
 * `face.load()` was in flight — a stale face must never enter FontFaceSet or `onRegistered`
 * after the scope stopped wanting it, or it leaks there unowned.
 */
export async function webRegisterFont(
  family: string,
  style: string,
  dataUrl: string,
  onRegistered?: (face: FontFace) => void,
  isCurrent?: () => boolean,
): Promise<boolean> {
  if (typeof document === "undefined" || typeof FontFace === "undefined") return false;
  try {
    const face = new FontFace(family, `url(${dataUrl})`, {
      weight: String(weightForStyle(style)),
      style: isItalicStyle(style) ? "italic" : "normal",
    });
    await face.load();
    // The await above is the whole race window: an unmount/version switch mid-load means the
    // owner's dispose already ran, so adding (and tracking) this face now would resurrect it
    // into a scope that no longer wants it.
    if (isCurrent && !isCurrent()) return false;
    document.fonts.add(face);
    onRegistered?.(face);
    return true;
  } catch {
    return false;
  }
}

export interface FigmaAssets {
  imageForRef: (imageRef: string) => CanvasImageSource | null;
  /**
   * Decoded fallback raster for a node, or null while it loads. `nodeType` is the renderer's
   * node type (ADR-0042): the quality path routes "TEXT" to the outlined-SVG cache and keeps
   * every other type on PNG. Callers that do not know the type get the legacy PNG routing.
   */
  fallbackForNode: (nodeId: string, nodeType?: string) => CanvasImageSource | null;
  fontAvailable: (family: string, style: string) => boolean;
  /** Ask for a frame's raster thumbnail at a scale; returns null until decoded. */
  requestThumbnail: (nodeId: string, scale: number) => CanvasImageSource | null;
  /** Renderer `onMissing` hook: kick the fetches the draw discovered it needs. */
  onMissing: (missing: {
    fallbackNodeIds: string[];
    /** Font-missing TEXT ids (W8's MissingReport addition); always `[]` until the renderer lands it. */
    textFallbackNodeIds?: string[];
    imageRefs: string[];
    fonts: { family: string; style: string }[];
  }) => void;
  /**
   * The REAL ledger across every cache (fills, namespaced rasters, fonts): attempts not yet
   * delivered and terminal failures. Backs the canvas's honest loading status (spec 32.5.1) —
   * it reports what the caches actually hold, never fabricated counts, and probing does not
   * observe (unlike get/request/fontAvailable, it cannot pin a key across reconciliation).
   * ADR-0042 readiness rule: a font attempt whose TEXT nodes already have a ready replacement
   * raster stops counting — the visible paint is complete, and an optional font download must
   * not hold the line at loading/failed. The raster attempts themselves always count.
   */
  status: () => { pending: number; failed: number };
  /** Targeted retry: drop failed asset attempts so the next paint re-requests them. */
  retryFailed: () => void;
  /**
   * Open/close one synchronous web paint (spec 32.5.1 bounded asset lifetime). Everything the
   * draw observed through get/request/fontAvailable survives; everything else is retired at
   * endDraw — decoded images, pending attempts, failed refs, and unused FontFaces (removed from
   * document.fonts). An empty draw clears the lot. begin is idempotent while open, end without
   * a begin is a no-op, and callers that never use the pair keep the old accumulate-until-clear
   * behavior. The canvas wraps each paint; nothing else may call these during a draw.
   */
  beginDraw: () => void;
  endDraw: () => void;
  subscribe: (listener: () => void) => () => void;
}

/** Either cache: paint reconciliation with the same name on both sides. */
interface Reconcilable {
  beginDraw(): void;
  endDraw(): Set<string>;
}

function toSource(image: DecodedImageLike | null): CanvasImageSource | null {
  return (image as unknown as CanvasImageSource) ?? null;
}

export function useFigmaAssets(input: {
  serverId: string;
  fileKey: string;
  version: string | null;
  /** Host advertised `figmaRenderFidelity` (ADR-0042): routes the quality path at all. */
  fidelity?: boolean;
  /** Current device pixels per Figma unit (zoom × dpr). Defaults to the legacy fixed rung. */
  getDeviceScale?: () => number;
  decodeImage?: ImageDecoder;
  registerFont?: (
    family: string,
    style: string,
    dataUrl: string,
    isCurrent?: () => boolean,
  ) => Promise<boolean>;
}): FigmaAssets {
  const { serverId, fileKey, version } = input;
  const client = useHostRuntimeClient(serverId);
  const decode = input.decodeImage ?? webDecode;
  // The ADR-0042 quality path exists only with BOTH the host capability and a pinned snapshot:
  // it reads versioned REST (never the live plugin), and an unpinned live scope must keep the
  // exact legacy wire — same scale-2 crop PNG requests, no format/bounds fields at all.
  const quality = input.fidelity === true && version !== null;
  // Identity-stable accessor: the caller's closure changes every render (it reads a ref), but
  // the memoized asset surface must not — and a stale closure still reads the live ref.
  const scaleReader = useRef(input.getDeviceScale);
  scaleReader.current = input.getDeviceScale;
  const deviceScale = useCallback(() => (scaleReader.current ? scaleReader.current() : 2), []);
  const listeners = useRef(new Set<() => void>());
  const notify = () => {
    for (const listener of Array.from(listeners.current)) listener();
  };
  // Caches registered with the currently open paint. Per-scale caches created DURING a draw
  // join the open observation here so their first get/onMissing keys survive that endDraw and
  // any other key they hold is reconciled like the caches that existed at beginDraw.
  const openDraw = useRef<Set<Reconcilable> | null>(null);
  // Faces the web registrar added to document.fonts, so dispose and paint reconciliation
  // really remove them.
  const faces = useRef(new Map<string, FontFace>());
  // ── ADR-0042 routing state (dies with the scope, cleared in the dispose effect) ──
  // Node types the renderer revealed through `fallbackForNode(id, nodeType)`; the quality
  // path only routes ids KNOWN to be TEXT to the outlined-SVG cache, everything else to PNG.
  const nodeTypes = useRef(new Map<string, "TEXT" | "OTHER">());
  // One-shot gate for the finite SVG→PNG downgrade per (node, version): an SVG attempt that
  // failed terminal asks for the absolute-bounds PNG exactly once, never a retry loop.
  const textPngOnce = useRef(new Set<string>());
  // fontKey → TEXT node ids reported missing alongside that face in the current paint.
  // Rebuilt at every beginDraw so readiness tracks the visible paint's actual dependencies.
  const fontFallbackOwners = useRef(new Map<string, string[]>());
  const registerDefault = useCallback(
    (family: string, style: string, dataUrl: string, isCurrent: () => boolean) =>
      webRegisterFont(
        family,
        style,
        dataUrl,
        (face) => {
          const key = `${family}\u0000${style}`;
          const previous = faces.current.get(key);
          if (previous && typeof document !== "undefined") document.fonts.delete(previous);
          faces.current.set(key, face);
        },
        isCurrent,
      ),
    [],
  );
  const register = input.registerFont ?? registerDefault;

  const imageFills = useMemo(
    () =>
      new ByteImageCache(
        async (refs) => {
          if (!client) return {};
          const data = await callFigma(client, "figma.file.imageFills.request", {
            fileKey,
            imageRefs: [...refs],
          });
          return data.images as Record<string, FigmaBytes | null>;
        },
        decode,
        notify,
      ),
    [client, fileKey, decode],
  );

  const rasters = useMemo(() => {
    const byNamespace = new Map<string, ByteImageCache>();
    return {
      get: (scale: number, format: RasterFormat, bounds: RasterBounds) => {
        const ns = rasterNamespace(scale, format, bounds, version);
        let cacheForScale = byNamespace.get(ns);
        if (!cacheForScale) {
          cacheForScale = new ByteImageCache(
            async (ids) => {
              if (!client) return {};
              const data = await callFigma(client, "figma.file.render.request", {
                fileKey,
                ids: [...ids],
                scale,
                ...(version ? { version } : {}),
                // Only the quality path sends the new fields — and only when the cache exists
                // because of it: the legacy wire stays byte-identical to pre-ADR-0042 daemons,
                // which never saw `format`/`useAbsoluteBounds` on this RPC. Crop exports keep
                // Figma's default semantics by omitting the bounds flag entirely.
                ...(quality
                  ? { format, ...(bounds === "absolute" ? { useAbsoluteBounds: true } : {}) }
                  : {}),
              });
              return data.images as Record<string, FigmaBytes | null>;
            },
            decode,
            notify,
          );
          byNamespace.set(ns, cacheForScale);
          // A cache born mid-draw must join the open observation, or its first paint's keys
          // would reconcile away before the draw that asked for them ever closes.
          if (openDraw.current) {
            openDraw.current.add(cacheForScale);
            cacheForScale.beginDraw();
          }
        }
        return cacheForScale;
      },
      all: () => [...byNamespace.values()],
      dispose: () => {
        for (const cacheForScale of byNamespace.values()) cacheForScale.clear();
        byNamespace.clear();
      },
    };
  }, [client, fileKey, version, decode, quality]);

  const fonts = useMemo(
    () =>
      new FontCache(
        async (family, style) => {
          if (!client) return null;
          const data = await callFigma(client, "figma.fonts.get.request", { family, style });
          return data.font;
        },
        register,
        notify,
      ),
    [client, register],
  );

  // Owner unmount or scope change (host, file, version, decoder swap) retires the caches built
  // for the old scope: in-flight settles land in a dead generation and are dropped (no stale
  // repopulate, no stale notify), failed entries stop being retried only by an actual clear, and
  // web-registered FontFaces are removed from document.fonts so a reconnect cannot leak faces.
  useEffect(
    () => () => {
      openDraw.current = null;
      imageFills.clear();
      rasters.dispose();
      fonts.clear();
      nodeTypes.current.clear();
      textPngOnce.current.clear();
      fontFallbackOwners.current.clear();
      for (const face of faces.current.values()) {
        if (typeof document !== "undefined") document.fonts.delete(face);
      }
      faces.current.clear();
    },
    [imageFills, rasters, fonts],
  );

  return useMemo<FigmaAssets>(() => {
    const releaseFaces = (keys: Set<string>): void => {
      for (const key of keys) {
        const face = faces.current.get(key);
        if (!face) continue;
        if (typeof document !== "undefined") document.fonts.delete(face);
        faces.current.delete(key);
      }
    };
    /** The raster cache a fallback ask must use — the single routing decision shared by
     *  `fallbackForNode` (read) and `onMissing` (fetch), so a get can never miss the cache
     *  its request went into. */
    const rasterCacheFor = (nodeId: string): ByteImageCache => {
      if (!quality) return rasters.get(2, "png", "crop");
      if (nodeTypes.current.get(nodeId) === "TEXT") return rasters.get(1, "svg", "absolute");
      return rasters.get(rasterRung(deviceScale()), "png", "crop");
    };
    /** Non-observing: does ANY raster cache hold a decoded image for this node? */
    const hasReadyRaster = (nodeId: string): boolean =>
      rasters.all().some((cache) => cache.has(nodeId));
    return {
      imageForRef: (imageRef) => toSource(imageFills.get(imageRef)),
      fallbackForNode: (nodeId, nodeType) => {
        if (!nodeId) return null;
        if (nodeType) nodeTypes.current.set(nodeId, nodeType === "TEXT" ? "TEXT" : "OTHER");
        if (quality && nodeTypes.current.get(nodeId) === "TEXT") {
          const svg = rasters.get(1, "svg", "absolute");
          if (svg.stateOf(nodeId) === "failed") {
            // Finite per node+version (ADR-0042): the SVG failed terminal, ask the absolute-
            // bounds PNG ONCE — same drawing box, raster instead of vectors — and never again
            // until an explicit retry clears the gate. No SVG/PNG ping-pong per paint.
            const png = rasters.get(rasterRung(deviceScale()), "png", "absolute");
            const onceKey = `${nodeId}@${version}`;
            if (!textPngOnce.current.has(onceKey)) {
              textPngOnce.current.add(onceKey);
              png.request(nodeId);
            }
            return toSource(png.get(nodeId));
          }
          return toSource(svg.get(nodeId));
        }
        return toSource(rasterCacheFor(nodeId).get(nodeId));
      },
      fontAvailable: (family, style) => fonts.fontAvailable(family, style),
      requestThumbnail: (nodeId, scale) => toSource(rasters.get(scale, "png", "crop").get(nodeId)),
      onMissing: (missing) => {
        imageFills.request(...missing.imageRefs);
        // Record the renderer's TEXT classification FIRST (W8 emits these ids; `[]` until it
        // lands), then split the fallback asks: known TEXT rides the outlined-SVG cache,
        // everything else stays default-crop PNG on the adaptive rung (legacy: fixed scale 2).
        for (const id of missing.textFallbackNodeIds ?? []) nodeTypes.current.set(id, "TEXT");
        const textIds: string[] = [];
        const otherIds: string[] = [];
        for (const id of missing.fallbackNodeIds) {
          if (quality && nodeTypes.current.get(id) === "TEXT") textIds.push(id);
          else otherIds.push(id);
        }
        if (textIds.length > 0) rasters.get(1, "svg", "absolute").request(...textIds);
        if (otherIds.length > 0) {
          const cache = quality
            ? rasters.get(rasterRung(deviceScale()), "png", "crop")
            : rasters.get(2, "png", "crop");
          cache.request(...otherIds);
        }
        for (const font of missing.fonts) {
          fonts.fontAvailable(font.family, font.style);
          if (textIds.length === 0) continue;
          // This face's node set is being replaced by exact SVG outlines this paint: the
          // font attempt becomes optional, and readiness must judge it by its replacement.
          const key = `${font.family}\u0000${font.style}`;
          const owners = fontFallbackOwners.current.get(key) ?? [];
          for (const id of textIds) if (!owners.includes(id)) owners.push(id);
          fontFallbackOwners.current.set(key, owners);
        }
      },
      // Probes the caches' real records — no observation, no pinning, no fabricated numbers:
      // pending counts attempts not yet delivered, failed counts terminal attempts still held.
      // Font attempts whose TEXT owners already have a ready replacement raster do NOT count
      // (ADR-0042): the visible paint is complete; the fallback attempts themselves always do.
      status: () => {
        let pending = 0;
        let failed = 0;
        for (const cache of [imageFills, ...rasters.all()]) {
          const state = cache.status();
          pending += state.pending;
          failed += state.failed;
        }
        for (const attempt of fonts.unresolved()) {
          const owners = fontFallbackOwners.current.get(attempt.key);
          if (owners && owners.length > 0 && owners.every(hasReadyRaster)) continue;
          if (attempt.pending) pending += 1;
          else failed += 1;
        }
        return { pending, failed };
      },
      retryFailed: () => {
        // Drop terminal failures everywhere; clearing the downgrade gate lets a retried SVG
        // that fails again take its single PNG shot instead of being locked out forever.
        textPngOnce.current.clear();
        for (const cache of [imageFills, fonts, ...rasters.all()]) cache.retryFailed();
      },
      beginDraw: () => {
        // Rebuilt each begin so scales first used mid-draw are covered; per-cache begin is
        // idempotent, so a duplicate call never resets an open observation set.
        fontFallbackOwners.current = new Map();
        const caches = new Set<Reconcilable>([imageFills, fonts, ...rasters.all()]);
        openDraw.current = caches;
        for (const cache of caches) cache.beginDraw();
      },
      endDraw: () => {
        const caches = openDraw.current;
        openDraw.current = null;
        if (!caches) return;
        for (const cache of Array.from(caches)) {
          const retired = cache.endDraw();
          // The only cache whose retirements own DOM state: release its unused FontFaces.
          if (cache === fonts) releaseFaces(retired);
        }
      },
      subscribe: (listener) => {
        listeners.current.add(listener);
        return () => listeners.current.delete(listener);
      },
    };
  }, [imageFills, rasters, fonts, quality, deviceScale]);
}
