import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { createFigmaRenderer } from "@/figma/renderer";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import { callFigma } from "./figma-api";
import { collectRequiredFonts, type RequiredFont } from "./font-loading";
import { nodeBounds, toFrameLocalNodes } from "./node-geometry";
import { usePrototypeAssetScope, type PrototypeAssetScopeHandle } from "./asset-scope";
import type { AssetClaim, PrototypeAssetStore } from "./asset-store";
import type { FrameContentProps } from "./frame-content";

// Web frame surface: draws the frame subtree through the renderer contract (spec 32.5.1/32.5.3)
// onto a Canvas 2D context. The renderer never fetches — this file answers its onMissing calls
// with image fills (figma.file.imageFills) and fallback rasters (figma.file.render), decoding
// the returned bytes locally. The subtree is rewritten in frame-local coordinates first: the
// canvas spans one frame, and the renderer places nodes by absoluteBoundingBox, so an
// unlocalized frame at x=1200 would paint off-canvas.
//
// Every byte, stylesheet, and FontFace this draws through belongs to the player's asset scope
// (`asset-store.ts`) and is claimed under THIS instance's stage-owner identity: when the root
// changes (a reused instance navigating) or the instance unmounts, the previous owner's claims
// are released while the player stays open, and only assets a simultaneously active owner still
// shares survive. Render requests pin the scope's snapshot `version` — keys alone let late
// bytes from an older snapshot paint as if current.

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

interface RefClaim {
  id: string;
  claim: AssetClaim;
}

async function fetchFills(
  client: DaemonClient,
  store: PrototypeAssetStore,
  fileKey: string,
  claims: RefClaim[],
): Promise<void> {
  const byRef = new Map(claims.map((entry) => [entry.id, entry.claim]));
  const data = await callFigma(client, "figma.file.imageFills.request", {
    fileKey,
    imageRefs: claims.map((entry) => entry.id),
  });
  if (store.disposed) return;
  for (const [ref, bytes] of Object.entries(data.images)) {
    const claim = byRef.get(ref);
    // A released claim drops inside putDecoded; nothing here revives cleared entries.
    if (claim) store.putDecoded(fillKey(ref), bytes, claim);
  }
}

async function fetchRasters(
  client: DaemonClient,
  store: PrototypeAssetStore,
  fileKey: string,
  version: string,
  claims: RefClaim[],
): Promise<void> {
  const byId = new Map(claims.map((entry) => [entry.id, entry.claim]));
  // Pin the snapshot: the daemon's versioned cache is what makes these bytes historical rather
  // than "latest" (a live-link drift could otherwise paint newer bytes into an older frame).
  const data = await callFigma(client, "figma.file.render.request", {
    fileKey,
    ids: claims.map((entry) => entry.id),
    scale: 2,
    version,
  });
  if (store.disposed) return;
  for (const [id, bytes] of Object.entries(data.images)) {
    const claim = byId.get(id);
    if (claim) store.putDecoded(rasterKey(id), bytes, claim);
  }
}

// Per-instance identity so a reused FrameContent navigating between roots owns distinct claim
// sets — the old root's assets must be releasable while the new root keeps whatever it shares.
let frameContentSequence = 0;

export function FrameContent({ file, root, scale, overrides }: FrameContentProps) {
  const client = useHostRuntimeClient(file.serverId);
  const scope = usePrototypeAssetScope();
  const store = scope?.store ?? null;
  const fontGate = scope?.fontGate ?? null;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [assetsReady, setAssetsReady] = useState(0);
  const renderer = useMemo(() => createFigmaRenderer(), []);
  const onMissingRef = useRef<(missing: MissingAssets) => void>(() => {});

  const instanceIdRef = useRef<number | null>(null);
  if (instanceIdRef.current === null) instanceIdRef.current = ++frameContentSequence;
  const ownerId = `${instanceIdRef.current}:${root.id}`;
  const heldOwnersRef = useRef<Set<string>>(new Set());
  heldOwnersRef.current.add(ownerId);

  const requiredFonts = useMemo(() => collectRequiredFonts(root), [root]);

  // Font loading runs IN PARALLEL with drawing (W8 5d0b57396: the renderer paints TEXT as a real
  // Figma raster while a face is in flight), so a blocked Google stylesheet can never hold the
  // player blank. When a face actually becomes available the repaint below replaces the raster
  // with live text. Unavailable fonts SETTLE (the bounded gate remembers failures): this fires
  // its repaint only for claims made while a load was still in flight, once per root.
  useEffect(() => {
    if (!fontGate || requiredFonts.length === 0) return;
    let cancelled = false;
    void fontGate
      .loadForOwner(ownerId, requiredFonts)
      .then((becameAvailable) => {
        if (!cancelled && becameAvailable) setAssetsReady((tick) => tick + 1);
        return undefined;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requiredFonts, fontGate]);

  useEffect(() => {
    if (!store) return;
    const unsubscribe = store.subscribe(() => setAssetsReady((tick) => tick + 1));
    return unsubscribe;
  }, [store]);

  onMissingRef.current = (missing: MissingAssets) => {
    if (!client || !store || store.disposed || !scope) return;
    // `claim` is the dedupe: one fetch per asset, shared by every simultaneously active owner
    // on stage; only the call that started the fetch holds a token to settle it.
    const imageClaims: RefClaim[] = [];
    for (const ref of missing.imageRefs) {
      const claim = store.claim(ownerId, fillKey(ref));
      if (claim) imageClaims.push({ id: ref, claim });
    }
    const rasterClaims: RefClaim[] = [];
    for (const id of missing.fallbackNodeIds) {
      const claim = store.claim(ownerId, rasterKey(id));
      if (claim) rasterClaims.push({ id, claim });
    }
    if (imageClaims.length > 0) {
      void fetchFills(client, store, file.fileKey, imageClaims).catch(() => undefined);
    }
    if (rasterClaims.length > 0) {
      void fetchRasters(client, store, file.fileKey, scope.version, rasterClaims).catch(
        () => undefined,
      );
    }
    if (missing.fonts.length > 0 && fontGate) {
      // Bounded by construction: the gate singleflights per family, remembers failed attempts,
      // and appends each stylesheet at most once. Repaint only when a face actually became
      // available — a failed font must not re-arm this draw loop on every pass.
      void fontGate
        .loadForOwner(ownerId, missing.fonts as RequiredFont[])
        .then((becameAvailable) => {
          if (becameAvailable) setAssetsReady((tick) => tick + 1);
          return undefined;
        })
        .catch(() => undefined);
    }
  };

  const imageForRef = useCallback(
    (ref: string) => {
      if (!store) return null;
      const key = fillKey(ref);
      const entry = store.get(key);
      if (!entry) return null;
      // Cache hit IS use: attach this owner so the frame that supplied the bytes releasing
      // (navigation, unmount) cannot free them while this frame still paints with them. The
      // real renderer only reports assets the getters miss, so this is the only attach point.
      store.attachOwner(ownerId, key);
      return entry.image;
    },
    [store, ownerId],
  );
  const fallbackForNode = useCallback(
    (nodeId: string) => {
      if (!store) return null;
      const key = rasterKey(nodeId);
      const entry = store.get(key);
      if (!entry) return null;
      store.attachOwner(ownerId, key);
      return entry.image;
    },
    [store, ownerId],
  );
  const fontAvailable = useCallback(
    (family: string, style: string) => (fontGate ? fontGate.fontAvailable(family, style) : false),
    [fontGate],
  );
  const onMissing = useCallback((missing: MissingAssets) => onMissingRef.current(missing), []);
  // Memoized geometry: a fresh `nodeBounds(root)` object every render would rebuild
  // `localRoot` and re-run the draw effect on every re-render, which is the re-render loop.
  const frame = useMemo(() => nodeBounds(root), [root]);
  const localRoot = useMemo<FigmaNode | null>(
    () => (frame ? toFrameLocalNodes(root, frame) : null),
    [root, frame],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !frame || !localRoot) return;
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
    renderer,
    imageForRef,
    fallbackForNode,
    fontAvailable,
    onMissing,
  ]);

  // Release the PREVIOUS root's claims after this commit has already drawn (and claimed) the
  // new one — declared after the draw effect so claim-before-release keeps assets shared across
  // the navigation held throughout. On unmount every owner identity this instance drew under is
  // released from both the asset store and the font gate.
  const releasedPrevRef = useRef<string | null>(null);
  useEffect(() => {
    if (releasedPrevRef.current === null) {
      releasedPrevRef.current = ownerId;
      return;
    }
    if (releasedPrevRef.current === ownerId) return;
    const previous = releasedPrevRef.current;
    releasedPrevRef.current = ownerId;
    scope?.releaseFrameOwner(previous);
  }, [ownerId, scope]);
  useEffect(
    () => () => {
      for (const held of Array.from(heldOwnersRef.current)) scope?.releaseFrameOwner(held);
      heldOwnersRef.current.clear();
    },
    [scope],
  );

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
