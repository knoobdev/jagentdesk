import { useCallback, useEffect, useMemo, useRef } from "react";
import type { FigmaBytes } from "@jagentdesk/protocol/figma/rpc-schemas";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { isItalicStyle, weightForStyle } from "../font-style";
import { callFigma } from "./api";
import { ByteImageCache, FontCache, type DecodedImageLike } from "./assets";

// Asset plumbing for the canvas (spec 32.5.1): the renderer never fetches, so these caches are
// the fetch side. Image fills, fallback rasters / thumbnails and fonts all come back as base64
// bytes (32.8) and decode to DOM images / FontFace here. The DOM decoders live behind injectable
// factories so the caches and their tests never require a real DOM.

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
  fallbackForNode: (nodeId: string) => CanvasImageSource | null;
  fontAvailable: (family: string, style: string) => boolean;
  /** Ask for a frame's raster thumbnail at a scale; returns null until decoded. */
  requestThumbnail: (nodeId: string, scale: number) => CanvasImageSource | null;
  /** Renderer `onMissing` hook: kick the fetches the draw discovered it needs. */
  onMissing: (missing: {
    fallbackNodeIds: string[];
    imageRefs: string[];
    fonts: { family: string; style: string }[];
  }) => void;
  /**
   * The REAL ledger across every cache (fills, per-scale rasters, fonts): attempts not yet
   * delivered and terminal failures. Backs the canvas's honest loading status (spec 32.5.1) —
   * it reports what the caches actually hold, never fabricated counts, and probing does not
   * observe (unlike get/request/fontAvailable, it cannot pin a key across reconciliation).
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
    const byScale = new Map<string, ByteImageCache>();
    return {
      get: (scale: number) => {
        let cacheForScale = byScale.get(String(scale));
        if (!cacheForScale) {
          cacheForScale = new ByteImageCache(
            async (ids) => {
              if (!client) return {};
              const data = await callFigma(client, "figma.file.render.request", {
                fileKey,
                ids: [...ids],
                scale,
                ...(version ? { version } : {}),
              });
              return data.images as Record<string, FigmaBytes | null>;
            },
            decode,
            notify,
          );
          byScale.set(String(scale), cacheForScale);
          // A cache born mid-draw must join the open observation, or its first paint's keys
          // would reconcile away before the draw that asked for them ever closes.
          if (openDraw.current) {
            openDraw.current.add(cacheForScale);
            cacheForScale.beginDraw();
          }
        }
        return cacheForScale;
      },
      all: () => [...byScale.values()],
      dispose: () => {
        for (const cacheForScale of byScale.values()) cacheForScale.clear();
        byScale.clear();
      },
    };
  }, [client, fileKey, version, decode]);

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
    return {
      imageForRef: (imageRef) => toSource(imageFills.get(imageRef)),
      fallbackForNode: (nodeId) => toSource(rasters.get(2).get(nodeId)),
      fontAvailable: (family, style) => fonts.fontAvailable(family, style),
      requestThumbnail: (nodeId, scale) => toSource(rasters.get(scale).get(nodeId)),
      onMissing: (missing) => {
        imageFills.request(...missing.imageRefs);
        rasters.get(2).request(...missing.fallbackNodeIds);
        for (const font of missing.fonts) fonts.fontAvailable(font.family, font.style);
      },
      // Probes the caches' real records — no observation, no pinning, no fabricated numbers:
      // pending counts attempts not yet delivered, failed counts terminal attempts still held.
      status: () => {
        let pending = 0;
        let failed = 0;
        for (const cache of [imageFills, fonts, ...rasters.all()]) {
          const state = cache.status();
          pending += state.pending;
          failed += state.failed;
        }
        return { pending, failed };
      },
      retryFailed: () => {
        for (const cache of [imageFills, fonts, ...rasters.all()]) cache.retryFailed();
      },
      beginDraw: () => {
        // Rebuilt each begin so scales first used mid-draw are covered; per-cache begin is
        // idempotent, so a duplicate call never resets an open observation set.
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
  }, [imageFills, rasters, fonts]);
}
