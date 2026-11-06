import { useCallback, useEffect, useMemo, useRef } from "react";
import type { FigmaBytes } from "@jagentdesk/protocol/figma/rpc-schemas";
import type { FigmaFallbackHint } from "@/figma/renderer";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { isItalicStyle, weightForStyle } from "../font-style";
import { callFigma } from "./api";
import {
  ByteImageCache,
  MAX_IMAGE_BATCHES_IN_FLIGHT,
  MAX_PREVIEW_EXPORT_BATCHES_IN_FLIGHT,
  backgroundBlurRasterRung,
  FontCache,
  isPinnedVersion,
  rasterNamespace,
  rasterRung,
  type DecodedImageLike,
  type RasterBounds,
  type RasterFormat,
  type RasterSpec,
} from "./assets";

// Asset plumbing for the canvas (spec 32.5.1): the renderer never fetches, so these caches are
// the fetch side. Image fills, fallback rasters / thumbnails and fonts all come back as base64
// bytes (32.8) and decode to DOM images / FontFace here. The DOM decoders live behind injectable
// factories so the caches and their tests never require a real DOM.
// ADR-0042 quality path (host capability + pinned version): TEXT fallbacks become Figma-exported
// outlined SVGs drawn at the absolute bounding box — crisp at any zoom, correct glyphs without
// the font — with one finite absolute-bounds PNG downgrade per node if the SVG fails; non-TEXT
// rasters ride an adaptive rung ceil(zoom × dpr) clamped 1..4 instead of the legacy fixed 2;
// fallbacks the renderer HINTS as visible BACKGROUND_BLUR ride min(rung, proven-correct scale)
// crop PNG — Figma's per-node export bakes no backdrop above that scale (backdrop exception).
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
   * `hint.backgroundBlur` (ADR-0042 backdrop exception) must arrive on the FIRST ask: the
   * getter itself queues the fetch on a miss, so a classification only reported later with the
   * missing report would already have asked (and cached) a flat high-rung raster. Absent or
   * false on any ask lifts the cap for this scope (a hidden/dropped effect never inherits the
   * previous paint's cap — the getter runs for every fallback node on every paint).
   */
  fallbackForNode: (
    nodeId: string,
    nodeType?: string,
    hint?: FigmaFallbackHint,
  ) => CanvasImageSource | null;
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
   * The REAL demand ledger for this owner's latest paint (spec 32.5.1): only what the draw
   * actually SELECTED through the getters, thumbnails and routed fetches — probed
   * non-observing, never fabricated. Retired offscreen failures and stale rungs hold no slot,
   * so a successful PNG downgrade is not haunted by its earlier failed SVG, while a genuinely
   * both-failed node or an undelivered required fill still reports pending/failed honestly.
   * ADR-0042 readiness rule: a font attempt stops counting only when EVERY TEXT node it was
   * reported with paints from its selected replacement raster (verified against that exact
   * cache at probe time) — an optional font download must not hold the line at loading/error,
   * but pending or failed fallbacks still count and missing glyphs are never "ready".
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
  const cachedRender = useHostFeature(serverId, "figmaCachedRender");
  const decode = input.decodeImage ?? webDecode;
  // The ADR-0042 quality path exists only with BOTH the host capability and a PINNED
  // snapshot: it reads versioned REST (never the live plugin), and an unpinned live scope
  // must keep the exact legacy wire — same scale-2 crop PNG requests, no format/bounds
  // fields at all. Contract edge: the daemon REFUSES svg/useAbsoluteBounds without a
  // non-empty version, so an empty or whitespace-only pin is the same no-pin case.
  const quality = input.fidelity === true && isPinnedVersion(version);
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
  // Ids the renderer hinted as visible BACKGROUND_BLUR at their latest fallback ask (ADR-0042
  // backdrop exception). Last-write-per-getter, not per-paint: every fallback node passes the
  // getter on every paint it is drawn, so a hidden or removed effect (hint false/absent on the
  // next ask) lifts the cap immediately and the node never inherits a stale paint's cap. The
  // set holds ids only — never node trees — and dies with the scope.
  const bgBlurNodes = useRef(new Set<string>());
  // Persistent per-node downgrade channel (`${nodeId}@${version}`): once a TEXT node's SVG
  // attempt failed terminal, every LATER ask — reads and fetches alike — routes to the
  // absolute-bounds PNG. Independent of the SVG cache's own retention (an unobserved failed
  // entry reconciles away at endDraw; without this channel the next paint would restart SVG
  // and ping-pong forever). Cleared only by retryFailed or scope disposal/switch. The PNG
  // itself is finite per (node, version, rung) by cache identity: one entry per rung, and the
  // rung's negative cache bounds retries — zooming to a new rung asks it exactly once.
  const downgradedText = useRef(new Set<string>());
  // The current draw's REAL demand ledger: which (cache, ref) pairs the paint selected through
  // the getters/thumbnails/routing, and which TEXT nodes were actually painted from a selected
  // replacement. status() reads this, not the union of every cache ever created — retired
  // offscreen failures and stale rungs must not haunt readiness. Rebuilt at every beginDraw.
  const selected = useRef(new Map<ByteImageCache, Set<string>>());
  const servedText = useRef(new Set<string>());
  // fontKey → TEXT node ids whose replacement raster this paint selects. Rebuilt at every
  // beginDraw so readiness tracks the visible paint's actual dependencies.
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
          const load = async (ids: readonly string[], cachedOnly = false) => {
            if (!client) return {};
            const response = await callFigma(client, "figma.file.render.request", {
              fileKey,
              ids: [...ids],
              scale,
              ...(version ? { version } : {}),
              ...(quality
                ? { format, ...(bounds === "absolute" ? { useAbsoluteBounds: true } : {}) }
                : {}),
              ...(cachedOnly ? { cachedOnly: true } : {}),
            });
            return response.images;
          };
          cacheForScale = new ByteImageCache(
            (ids) => load(ids),
            decode,
            notify,
            cachedRender && isPinnedVersion(version) ? (ids) => load(ids, true) : undefined,
            cachedRender && format === "png" && scale < 1
              ? MAX_PREVIEW_EXPORT_BATCHES_IN_FLIGHT
              : MAX_IMAGE_BATCHES_IN_FLIGHT,
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
  }, [client, fileKey, version, decode, quality, cachedRender]);

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
      bgBlurNodes.current.clear();
      downgradedText.current.clear();
      selected.current = new Map();
      servedText.current = new Set();
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
    /** The ONE routing decision, shared by reads (`fallbackForNode`) and fetches
     *  (`onMissing`), so a get can never miss the cache its request went into — and a
     *  downgraded TEXT never re-enters the SVG class. The BACKGROUND_BLUR class rides HERE too:
     *  capped crop PNG (absolute for TEXT, whose replacement class is always the layout box)
     *  at `min(rung, proven-correct scale)`, decided once and honored by every later read AND
     *  fetch, so zooming never asks the node's flat rung-3/4 export (no phantom rung). */
    const routeSpecFor = (nodeId: string): RasterSpec => {
      if (!quality) return { scale: 2, format: "png", bounds: "crop" };
      if (bgBlurNodes.current.has(nodeId)) {
        const capped = backgroundBlurRasterRung(deviceScale());
        return nodeTypes.current.get(nodeId) === "TEXT"
          ? { scale: capped, format: "png", bounds: "absolute" }
          : { scale: capped, format: "png", bounds: "crop" };
      }
      if (nodeTypes.current.get(nodeId) === "TEXT") {
        if (downgradedText.current.has(`${nodeId}@${version}`))
          return { scale: rasterRung(deviceScale()), format: "png", bounds: "absolute" };
        return { scale: 1, format: "svg", bounds: "absolute" };
      }
      return { scale: rasterRung(deviceScale()), format: "png", bounds: "crop" };
    };
    const cacheForSpec = (spec: RasterSpec): ByteImageCache =>
      rasters.get(spec.scale, spec.format, spec.bounds);
    /** Record a (cache, ref) pair this owner actually selected — the demand ledger status()
     *  reads. Selection is not observation (that stays with get/request), and a stale entry
     *  reads as null (not counted) once reconciliation retired it. */
    const select = (cache: ByteImageCache, ref: string): void => {
      let refs = selected.current.get(cache);
      if (!refs) {
        refs = new Set();
        selected.current.set(cache, refs);
      }
      refs.add(ref);
    };
    /** Is this TEXT node's SELECTED replacement cache holding decoded bytes right now? */
    const replacementReady = (nodeId: string): boolean =>
      cacheForSpec(routeSpecFor(nodeId)).stateOf(nodeId) === "ready";
    return {
      imageForRef: (imageRef) => {
        select(imageFills, imageRef);
        return toSource(imageFills.get(imageRef));
      },
      fallbackForNode: (nodeId, nodeType, hint) => {
        if (!nodeId) return null;
        if (nodeType) nodeTypes.current.set(nodeId, nodeType === "TEXT" ? "TEXT" : "OTHER");
        // The classifier sees the hint BEFORE any cache choice or queue: record true, drop
        // anything else (false or absent — W7 passes it fresh at every fallback ask).
        if (hint?.backgroundBlur === true) bgBlurNodes.current.add(nodeId);
        else bgBlurNodes.current.delete(nodeId);
        const spec = routeSpecFor(nodeId);
        const cache = cacheForSpec(spec);
        select(cache, nodeId);
        const image = cache.get(nodeId);
        if (image) {
          // Painted from the replacement this draw selected — the font becomes optional only
          // for THIS ledger entry, and status() verifies it against the selected cache.
          if (quality && nodeTypes.current.get(nodeId) === "TEXT") servedText.current.add(nodeId);
          return toSource(image);
        }
        // Quality TEXT on the SVG route whose attempt failed TERMINAL: engage the persistent
        // downgrade channel. get() on the PNG cache starts its one single-flight fetch; the
        // channel keeps every later read AND every later onMissing fetch on the PNG, per rung
        // (a zoom asks the new rung once, and the rung's negative cache holds the line).
        if (quality && spec.format === "svg" && cache.stateOf(nodeId) === "failed") {
          downgradedText.current.add(`${nodeId}@${version}`);
          const png = cacheForSpec(routeSpecFor(nodeId)); // re-route: now the PNG channel
          select(png, nodeId);
          const pngImage = png.get(nodeId);
          if (pngImage) servedText.current.add(nodeId);
          return toSource(pngImage);
        }
        return null;
      },
      fontAvailable: (family, style) => fonts.fontAvailable(family, style),
      requestThumbnail: (nodeId, scale) => {
        // Previews are placed into summary layout bounds. A cropped export would stretch
        // sparse text or transparent roots across their layout whitespace.
        const cache = rasters.get(scale, "png", quality ? "absolute" : "crop");
        select(cache, nodeId);
        return toSource(cache.get(nodeId));
      },
      onMissing: (missing) => {
        if (missing.imageRefs.length > 0) {
          imageFills.request(...missing.imageRefs);
          for (const ref of missing.imageRefs) select(imageFills, ref);
        }
        // Record the renderer's TEXT classification FIRST (W8 emits these ids; `[]` until it
        // lands), then group EVERY ask through the ONE route helper — TEXT→outlined SVG (or
        // its persistent PNG channel once downgraded), hinted BACKGROUND_BLUR→capped crop PNG,
        // everything else→default-crop PNG on the adaptive rung (legacy: fixed scale 2). One
        // wire batch per class, never mixed: the capped class must not ride the batch's rung.
        for (const id of missing.textFallbackNodeIds ?? []) nodeTypes.current.set(id, "TEXT");
        const textIds: string[] = [];
        const bySpec = new Map<string, { spec: RasterSpec; ids: string[] }>();
        for (const id of missing.fallbackNodeIds) {
          if (quality && nodeTypes.current.get(id) === "TEXT") textIds.push(id);
          const spec = routeSpecFor(id);
          const ns = `${spec.scale}@${spec.format}@${spec.bounds}`;
          const group = bySpec.get(ns) ?? { spec, ids: [] };
          group.ids.push(id);
          bySpec.set(ns, group);
        }
        // ONE route helper, not "always SVG for TEXT": a downgraded node's re-ask lands on the
        // PNG cache of the CURRENT rung — where ByteImageCache's own records dedupe (an
        // existing queued/loading/failed entry never refetches; a fresh rung asks once).
        for (const { spec, ids } of bySpec.values()) {
          const cache = cacheForSpec(spec);
          cache.request(...ids);
          for (const id of ids) select(cache, id);
        }
        for (const font of missing.fonts) {
          fonts.fontAvailable(font.family, font.style);
          // Associate the face with the TEXT nodes this paint actually paints from a selected
          // replacement — NOT just the ids the draw reported as missing: once the SVG is ready
          // the renderer reports the font but no longer reports the fallback missing, and a
          // ledger keyed on the report would count the optional font as a false failure.
          const owners = new Set<string>([...servedText.current, ...textIds]);
          if (owners.size === 0) continue;
          const key = `${font.family}\u0000${font.style}`;
          const existing = fontFallbackOwners.current.get(key) ?? [];
          for (const id of owners) if (!existing.includes(id)) existing.push(id);
          fontFallbackOwners.current.set(key, existing);
        }
      },
      // The REAL ledger for the canvas's honest loading status (spec 32.5.1): what THIS owner's
      // latest paint selected (getters, thumbnails, routed fetches) — probed non-observing, so
      // readiness never pins entries itself. A retired SVG or stale rung holds no slot here,
      // which is why a successful PNG downgrade cannot be haunted by its failed SVG, while
      // both-failed (the PNG itself terminal) and never-served glyphs still report true.
      // Font attempts count unless every associated TEXT node paints from its selected
      // replacement, verified against that replacement's own cache at probe time.
      status: () => {
        let pending = 0;
        let failed = 0;
        for (const [cache, refs] of selected.current) {
          for (const ref of refs) {
            const state = cache.stateOf(ref);
            if (state === "failed") failed += 1;
            else if (state === "queued" || state === "loading") pending += 1;
          }
        }
        for (const attempt of fonts.unresolved()) {
          const owners = fontFallbackOwners.current.get(attempt.key);
          if (
            owners &&
            owners.length > 0 &&
            owners.every((id) => servedText.current.has(id) && replacementReady(id))
          )
            continue;
          if (attempt.pending) pending += 1;
          else failed += 1;
        }
        return { pending, failed };
      },
      retryFailed: () => {
        // Drop terminal failures everywhere AND reopen the downgrade channels: a retried SVG
        // gets a fresh chance, and one that fails again takes its single PNG route again.
        downgradedText.current.clear();
        selected.current.clear();
        servedText.current.clear();
        for (const cache of [imageFills, fonts, ...rasters.all()]) cache.retryFailed();
      },
      beginDraw: () => {
        // The ledger describes THIS paint; the previous one's selections retire with it
        // (between paints the last completed draw's ledger answers status()).
        selected.current = new Map();
        servedText.current = new Set();
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
  }, [imageFills, rasters, fonts, quality, version, deviceScale]);
}
