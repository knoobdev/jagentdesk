import { useMemo, useRef } from "react";
import type { FigmaBytes } from "@jagentdesk/protocol/figma/rpc-schemas";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
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

const webRegisterFont = async (
  family: string,
  style: string,
  dataUrl: string,
): Promise<boolean> => {
  if (typeof document === "undefined" || typeof FontFace === "undefined") return false;
  try {
    const face = new FontFace(`${family} ${style}`, `url(${dataUrl})`);
    await face.load();
    document.fonts.add(face);
    return true;
  } catch {
    return false;
  }
};

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
  subscribe: (listener: () => void) => () => void;
}

function toSource(image: DecodedImageLike | null): CanvasImageSource | null {
  return (image as unknown as CanvasImageSource) ?? null;
}

export function useFigmaAssets(input: {
  serverId: string;
  fileKey: string;
  version: string | null;
  decodeImage?: ImageDecoder;
  registerFont?: (family: string, style: string, dataUrl: string) => Promise<boolean>;
}): FigmaAssets {
  const { serverId, fileKey, version } = input;
  const client = useHostRuntimeClient(serverId);
  const decode = input.decodeImage ?? webDecode;
  const register = input.registerFont ?? webRegisterFont;
  const listeners = useRef(new Set<() => void>());
  const notify = () => {
    for (const listener of Array.from(listeners.current)) listener();
  };

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
    const cache = new Map<string, ByteImageCache>();
    const get = (scale: number) => {
      let cacheForScale = cache.get(String(scale));
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
        cache.set(String(scale), cacheForScale);
      }
      return cacheForScale;
    };
    return { get };
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

  return useMemo<FigmaAssets>(
    () => ({
      imageForRef: (imageRef) => toSource(imageFills.get(imageRef)),
      fallbackForNode: (nodeId) => toSource(rasters.get(2).get(nodeId)),
      fontAvailable: (family, style) => fonts.fontAvailable(family, style),
      requestThumbnail: (nodeId, scale) => toSource(rasters.get(scale).get(nodeId)),
      onMissing: (missing) => {
        imageFills.request(...missing.imageRefs);
        rasters.get(2).request(...missing.fallbackNodeIds);
        for (const font of missing.fonts) fonts.fontAvailable(font.family, font.style);
      },
      subscribe: (listener) => {
        listeners.current.add(listener);
        return () => listeners.current.delete(listener);
      },
    }),
    [imageFills, rasters, fonts],
  );
}
