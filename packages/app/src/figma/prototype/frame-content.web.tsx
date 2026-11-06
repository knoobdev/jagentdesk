import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { createFigmaRenderer } from "@/figma/renderer";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import { callFigma } from "./figma-api";
import { collectRequiredFonts, type RequiredFont } from "./font-loading";
import { nodeBounds, toFrameLocalNodes } from "./node-geometry";
import { usePrototypeAssetScope, type PrototypeAssetScopeHandle } from "./asset-scope";
import type { PrototypeAssetStore } from "./asset-store";
import type { FrameContentProps } from "./frame-content";

// Web frame surface: draws the frame subtree through the renderer contract (spec 32.5.1/32.5.3)
// onto a Canvas 2D context. The renderer never fetches — this file answers its onMissing calls
// with image fills (figma.file.imageFills) and fallback rasters (figma.file.render), decoding
// the returned bytes locally. The subtree is rewritten in frame-local coordinates first: the
// canvas spans one frame, and the renderer places nodes by absoluteBoundingBox, so an
// unlocalized frame at x=1200 would paint off-canvas.
//
// Every byte, stylesheet, and FontFace this draws through belongs to the player's asset scope
// (`asset-store.ts`): keyed by server/file/version, shared by all frames on stage, and disposed
// when the player closes or the pinned version changes. Decodes and fetches that land after
// disposal drop themselves instead of reviving cleared memory.

interface MissingAssets {
  fallbackNodeIds: string[];
  imageRefs: string[];
  fonts: { family: string; style: string }[];
}

function fillKey(ref: string): string {
  return `fill|${ref}`;
}

function rasterKey(nodeId: string): string {
  return `raster|${nodeId}`;
}

async function fetchFills(
  client: DaemonClient,
  store: PrototypeAssetStore,
  fileKey: string,
  imageRefs: string[],
): Promise<void> {
  const data = await callFigma(client, "figma.file.imageFills.request", { fileKey, imageRefs });
  if (store.disposed) return;
  for (const [ref, bytes] of Object.entries(data.images)) {
    store.putDecoded(fillKey(ref), bytes);
  }
}

async function fetchRasters(
  client: DaemonClient,
  store: PrototypeAssetStore,
  fileKey: string,
  ids: string[],
): Promise<void> {
  const data = await callFigma(client, "figma.file.render.request", { fileKey, ids, scale: 2 });
  if (store.disposed) return;
  for (const [id, bytes] of Object.entries(data.images)) {
    store.putDecoded(rasterKey(id), bytes);
  }
}

export function FrameContent({ file, root, scale, overrides }: FrameContentProps) {
  const client = useHostRuntimeClient(file.serverId);
  const scope = usePrototypeAssetScope();
  const store = scope?.store ?? null;
  const fontGate = scope?.fontGate ?? null;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [assetsReady, setAssetsReady] = useState(0);
  const [fontsSettled, setFontsSettled] = useState(false);
  const renderer = useMemo(() => createFigmaRenderer(), []);
  const onMissingRef = useRef<(missing: MissingAssets) => void>(() => {});

  const requiredFonts = useMemo(() => collectRequiredFonts(root), [root]);

  // The first paint waits for the file's fonts: drawing earlier paints every TEXT node with the
  // generic stack (serif on most browsers) and leaves the loaded face unused until something
  // else triggers a redraw. A scope swap (close, version switch) resets this and waits again.
  useEffect(() => {
    if (!fontGate) return;
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
    if (!store) return;
    const unsubscribe = store.subscribe(() => setAssetsReady((tick) => tick + 1));
    return unsubscribe;
  }, [store]);

  onMissingRef.current = (missing: MissingAssets) => {
    if (!client || !store || store.disposed) return;
    // `claim` is the dedupe: one fetch per asset per scope, across every frame on stage.
    const pendingImageRefs = missing.imageRefs.filter((ref) => store.claim(fillKey(ref)));
    const pendingNodes = missing.fallbackNodeIds.filter((id) => store.claim(rasterKey(id)));
    if (pendingImageRefs.length > 0) {
      void fetchFills(client, store, file.fileKey, pendingImageRefs).catch(() => undefined);
    }
    if (pendingNodes.length > 0) {
      void fetchRasters(client, store, file.fileKey, pendingNodes).catch(() => undefined);
    }
    if (missing.fonts.length > 0 && fontGate) {
      void fontGate
        .load(missing.fonts as RequiredFont[])
        .then(() => setAssetsReady((tick) => tick + 1))
        .catch(() => undefined);
    }
  };

  const imageForRef = useCallback(
    (ref: string) => store?.get(fillKey(ref))?.image ?? null,
    [store],
  );
  const fallbackForNode = useCallback(
    (nodeId: string) => store?.get(rasterKey(nodeId))?.image ?? null,
    [store],
  );
  const fontAvailable = useCallback(
    (family: string, style: string) => (fontGate ? fontGate.fontAvailable(family, style) : false),
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
  // Without a live scope there is nothing to draw with — no assets, no fonts — and drawing
  // before the player's snapshot exists would paint the previous file's bytes.
  if (!frame || !canvasStyle || !hasLiveScope(scope)) return null;
  return <canvas ref={canvasRef} style={canvasStyle} />;
}

function hasLiveScope(scope: PrototypeAssetScopeHandle | null): boolean {
  return scope !== null && !scope.store.disposed;
}
