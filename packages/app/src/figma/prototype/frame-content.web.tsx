import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { createFigmaRenderer } from "@/figma/renderer";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { FigmaBytes, FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import { callFigma } from "./figma-api";
import {
  collectRequiredFonts,
  createFontGate,
  isItalicStyle,
  weightForStyle,
  type RequiredFont,
} from "./font-loading";
import { nodeBounds, toFrameLocalNodes } from "./node-geometry";
import type { FrameContentProps } from "./frame-content";

// Web frame surface: draws the frame subtree through the renderer contract (spec 32.5.1/32.5.3)
// onto a Canvas 2D context. The renderer never fetches — this file answers its onMissing calls
// with image fills (figma.file.imageFills) and fallback rasters (figma.file.render), decoding
// the returned bytes locally. The subtree is rewritten in frame-local coordinates first: the
// canvas spans one frame, and the renderer places nodes by absoluteBoundingBox, so an
// unlocalized frame at x=1200 would paint off-canvas.

interface AssetEntry {
  status: "loading" | "ready" | "failed";
  image: HTMLImageElement | null;
}

const assetCache = new Map<string, AssetEntry>();
const assetListeners = new Set<() => void>();

function cacheKey(fileKey: string, kind: string, id: string): string {
  return `${fileKey}|${kind}|${id}`;
}

function putDecoded(key: string, bytes: FigmaBytes | null): void {
  if (!bytes) {
    assetCache.set(key, { status: "failed", image: null });
    return;
  }
  const entry: AssetEntry = { status: "loading", image: null };
  assetCache.set(key, entry);
  const image = new Image();
  image.addEventListener(
    "load",
    () => {
      assetCache.set(key, { status: "ready", image });
      for (const listener of assetListeners) listener();
    },
    { once: true },
  );
  image.addEventListener(
    "error",
    () => {
      assetCache.set(key, { status: "failed", image: null });
      for (const listener of assetListeners) listener();
    },
    { once: true },
  );
  image.src = `data:${bytes.mimeType};base64,${bytes.dataBase64}`;
}

async function fetchFills(
  client: DaemonClient,
  fileKey: string,
  imageRefs: string[],
): Promise<void> {
  const data = await callFigma(client, "figma.file.imageFills.request", { fileKey, imageRefs });
  for (const [ref, bytes] of Object.entries(data.images)) {
    putDecoded(cacheKey(fileKey, "fill", ref), bytes);
  }
}

async function fetchRasters(client: DaemonClient, fileKey: string, ids: string[]): Promise<void> {
  const data = await callFigma(client, "figma.file.render.request", { fileKey, ids, scale: 2 });
  for (const [id, bytes] of Object.entries(data.images)) {
    putDecoded(cacheKey(fileKey, "raster", id), bytes);
  }
}

function appendGoogleStylesheet(href: string): Promise<void> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") {
      resolve();
      return;
    }
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.addEventListener("load", () => resolve(), { once: true });
    link.addEventListener("error", () => resolve(), { once: true });
    document.head.appendChild(link);
  });
}

async function registerFontFace(font: RequiredFont, bytes: FigmaBytes): Promise<boolean> {
  if (typeof document === "undefined" || typeof FontFace === "undefined") return false;
  try {
    const face = new FontFace(
      font.family,
      `url(data:${bytes.mimeType};base64,${bytes.dataBase64})`,
      {
        weight: String(weightForStyle(font.style)),
        style: isItalicStyle(font.style) ? "italic" : "normal",
      },
    );
    await face.load();
    document.fonts.add(face);
    return true;
  } catch {
    return false;
  }
}

function isFontLoaded(family: string, style: string): boolean {
  if (typeof document === "undefined" || !document.fonts) return false;
  try {
    const italic = isItalicStyle(style) ? "italic " : "";
    return document.fonts.check(`${italic}${weightForStyle(style)} 16px "${family}"`);
  } catch {
    return false;
  }
}

function fontsReady(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return Promise.resolve();
  return document.fonts.ready.then(() => undefined);
}

interface MissingAssets {
  fallbackNodeIds: string[];
  imageRefs: string[];
  fonts: { family: string; style: string }[];
}

export function FrameContent({ file, root, scale, overrides }: FrameContentProps) {
  const client = useHostRuntimeClient(file.serverId);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [assetsReady, setAssetsReady] = useState(0);
  const [fontsSettled, setFontsSettled] = useState(false);
  const requestedRef = useRef(new Set<string>());
  const renderer = useMemo(() => createFigmaRenderer(), []);
  const onMissingRef = useRef<(missing: MissingAssets) => void>(() => {});

  const fontGate = useMemo(
    () =>
      createFontGate({
        appendStylesheet: appendGoogleStylesheet,
        loadFontBytes: async (family, style) => {
          const data = await callFigma(client, "figma.fonts.get.request", { family, style });
          return data.font;
        },
        registerFontFace,
        isFontLoaded,
        fontsReady,
      }),
    [client],
  );

  const requiredFonts = useMemo(() => collectRequiredFonts(root), [root]);

  // The first paint waits for the file's fonts: drawing earlier paints every TEXT node with the
  // generic stack (serif on most browsers) and leaves the loaded face unused until something
  // else triggers a redraw.
  useEffect(() => {
    let cancelled = false;
    setFontsSettled(false);
    const settle = async () => {
      await fontGate.load(requiredFonts);
      if (!cancelled) setFontsSettled(true);
    };
    void settle();
    return () => {
      cancelled = true;
    };
  }, [requiredFonts, fontGate]);

  useEffect(() => {
    const listener = () => setAssetsReady((tick) => tick + 1);
    assetListeners.add(listener);
    return () => {
      assetListeners.delete(listener);
    };
  }, []);

  onMissingRef.current = (missing: MissingAssets) => {
    if (!client) return;
    const pendingImageRefs = missing.imageRefs.filter((ref) => {
      const key = cacheKey(file.fileKey, "fill", ref);
      return !requestedRef.current.has(key) && !assetCache.has(key);
    });
    const pendingNodes = missing.fallbackNodeIds.filter((id) => {
      const key = cacheKey(file.fileKey, "raster", id);
      return !requestedRef.current.has(key) && !assetCache.has(key);
    });
    for (const ref of pendingImageRefs)
      requestedRef.current.add(cacheKey(file.fileKey, "fill", ref));
    for (const id of pendingNodes) requestedRef.current.add(cacheKey(file.fileKey, "raster", id));
    if (pendingImageRefs.length > 0) {
      void fetchFills(client, file.fileKey, pendingImageRefs).catch(() => undefined);
    }
    if (pendingNodes.length > 0) {
      void fetchRasters(client, file.fileKey, pendingNodes).catch(() => undefined);
    }
    if (missing.fonts.length > 0) {
      void fontGate
        .load(missing.fonts as RequiredFont[])
        .then(() => setAssetsReady((tick) => tick + 1))
        .catch(() => undefined);
    }
  };

  const imageForRef = useCallback(
    (ref: string) => assetCache.get(cacheKey(file.fileKey, "fill", ref))?.image ?? null,
    [file.fileKey],
  );
  const fallbackForNode = useCallback(
    (nodeId: string) => assetCache.get(cacheKey(file.fileKey, "raster", nodeId))?.image ?? null,
    [file.fileKey],
  );
  const fontAvailable = useCallback(
    (family: string, style: string) => fontGate.fontAvailable(family, style),
    [fontGate],
  );
  const onMissing = useCallback((missing: MissingAssets) => onMissingRef.current(missing), []);
  const frame = nodeBounds(root);
  const localRoot = useMemo<FigmaNode | null>(
    () => (frame ? toFrameLocalNodes(root, frame) : null),
    [root, frame],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !frame || !localRoot || !fontsSettled) return;
    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(frame.width * scale * dpr));
    const pixelHeight = Math.max(1, Math.round(frame.height * scale * dpr));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // The subtree is already frame-local, so the canvas origin is the frame origin: a second
    // -frame.x translation would push it out of its own canvas.
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
    renderer.draw(ctx, localRoot, {
      scale: scale * dpr,
      viewport: { x: 0, y: 0, width: frame.width, height: frame.height },
      imageForRef,
      fallbackForNode,
      fontAvailable,
      onMissing,
      overrides,
    });
  }, [
    localRoot,
    frame,
    scale,
    overrides,
    assetsReady,
    fontsSettled,
    renderer,
    imageForRef,
    fallbackForNode,
    fontAvailable,
    onMissing,
  ]);

  const canvasStyle = useMemo(
    () =>
      frame
        ? {
            position: "absolute" as const,
            left: 0,
            top: 0,
            width: frame.width * scale,
            height: frame.height * scale,
          }
        : null,
    [frame, scale],
  );
  if (!frame || !canvasStyle) return null;
  return <canvas ref={canvasRef} style={canvasStyle} />;
}
