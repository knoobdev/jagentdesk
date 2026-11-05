import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { createFigmaRenderer } from "@/figma/renderer";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { FigmaBytes } from "@jagentdesk/protocol/figma/rpc-schemas";
import { callFigma } from "./figma-api";
import { nodeBounds } from "./node-geometry";
import type { FrameContentProps } from "./frame-content";

// Web frame surface: draws the frame subtree through the renderer contract (spec 32.5.1/32.5.3)
// onto a Canvas 2D context. The renderer never fetches — this file answers its onMissing calls
// with image fills (figma.file.imageFills) and fallback rasters (figma.file.render), decoding
// the returned bytes locally.

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

export function FrameContent({ file, root, scale, overrides }: FrameContentProps) {
  const client = useHostRuntimeClient(file.serverId);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [assetsReady, setAssetsReady] = useState(0);
  const requestedRef = useRef(new Set<string>());
  const renderer = useMemo(() => createFigmaRenderer(), []);
  const onMissingRef = useRef<(missing: MissingAssets) => void>(() => {});

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
  };

  const imageForRef = useCallback(
    (ref: string) => assetCache.get(cacheKey(file.fileKey, "fill", ref))?.image ?? null,
    [file.fileKey],
  );
  const fallbackForNode = useCallback(
    (nodeId: string) => assetCache.get(cacheKey(file.fileKey, "raster", nodeId))?.image ?? null,
    [file.fileKey],
  );
  const fontAvailable = useCallback(() => true, []);
  const onMissing = useCallback((missing: MissingAssets) => onMissingRef.current(missing), []);
  const frame = nodeBounds(root);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !frame) return;
    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(frame.width * scale * dpr));
    const pixelHeight = Math.max(1, Math.round(frame.height * scale * dpr));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(
      scale * dpr,
      0,
      0,
      scale * dpr,
      -frame.x * scale * dpr,
      -frame.y * scale * dpr,
    );
    renderer.draw(ctx, root, {
      scale: scale * dpr,
      viewport: frame,
      imageForRef,
      fallbackForNode,
      fontAvailable,
      onMissing,
      overrides,
    });
  }, [
    root,
    frame,
    scale,
    overrides,
    assetsReady,
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

interface MissingAssets {
  fallbackNodeIds: string[];
  imageRefs: string[];
  fonts: { family: string; style: string }[];
}
