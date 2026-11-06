import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { createFigmaRenderer } from "@/figma/renderer";
import { isPinnedVersion, rasterRung, type RasterSpec } from "@/figma/canvas/assets";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { FigmaBytes, FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
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
// Every byte and FontFace this draws through belongs to the player's asset scope
// (`asset-store.ts`) and is claimed under THIS instance's stage-owner identity: when the root
// changes (a reused instance navigating) or the instance unmounts, the previous owner's claims
// are released while the player stays open, and only assets a simultaneously active owner still
// shares survive. Render requests pin the scope's snapshot `version` — keys alone let late
// bytes from an older snapshot paint as if current.
//
// ADR-0042 fidelity path: with the host capability, known-TEXT fallbacks come as Figma-exported
// outlined SVGs drawn at the absolute bounding box (crisp at any player zoom, correct glyphs
// without the font), with one finite absolute-bounds PNG downgrade per node+snapshot; non-TEXT
// rasters ride the quantized rung the player paints at instead of the legacy fixed scale 2.
// Without the capability every request is the exact legacy scale-2 crop PNG wire.

interface MissingAssets {
  fallbackNodeIds: string[];
  /** Font-missing TEXT ids from the renderer (ADR-0042): these route to the outlined-SVG cache. */
  textFallbackNodeIds?: string[];
  imageRefs: string[];
  fonts: { family: string; style: string }[];
}

function fillKey(ref: string): string {
  return `fill|${ref}`;
}

/**
 * Store keys carry every raster dimension — version, rung, format, bounds — so crop bytes never
 * answer an absolute-bounds ask, an SVG never shares a slot with the PNG of the same node, and
 * two rungs of one frame are distinct entries (`rasterRung` lattice, ≤4 per scope).
 */
function rasterKey(nodeId: string, version: string, spec: RasterSpec): string {
  return `raster|${version}|${spec.scale}|${spec.format}|${spec.bounds}|${nodeId}`;
}

interface RefClaim {
  id: string;
  claim: AssetClaim;
}

// Both figma.file.imageFills and figma.file.render cap the wire at 20 ids
// (packages/protocol/src/figma/rpc-schemas.ts:512-525). With W8 rasterizing every unavailable
// TEXT through the fallback path, a normal frame blows past that instantly, so claims are
// fetched in chunks — and EVERY claimed id settles, whether or not the response named it: an
// omitted entry is as missing as a null one and must not sit in "loading" forever (which
// would stall the repaint and re-report on every pass).
const WIRE_BATCH_LIMIT = 20;

async function fetchInChunks(
  store: PrototypeAssetStore,
  claims: RefClaim[],
  assetKey: (id: string) => string,
  request: (ids: string[]) => Promise<Record<string, FigmaBytes | null> | undefined>,
): Promise<void> {
  for (let start = 0; start < claims.length; start += WIRE_BATCH_LIMIT) {
    // Closed player: released claims drop on settle anyway, so never send a later chunk.
    if (store.disposed) return;
    const chunk = claims.slice(start, start + WIRE_BATCH_LIMIT);
    let images: Record<string, FigmaBytes | null> | undefined;
    try {
      images = await request(chunk.map((entry) => entry.id));
    } catch {
      images = undefined; // A failed RPC settles all of the chunk's claims as failed below.
    }
    if (store.disposed) return;
    // Iterate the CLAIMS, not the returned entries: omitted ids settle failed too, and a
    // released claim still drops inside putDecoded — nothing here revives cleared entries.
    for (const { id, claim } of chunk) {
      store.putDecoded(assetKey(id), images?.[id] ?? null, claim);
    }
  }
}

async function fetchFills(
  client: DaemonClient,
  store: PrototypeAssetStore,
  fileKey: string,
  claims: RefClaim[],
): Promise<void> {
  // Content-addressed: imageRefs ARE the key, so no version rides this request.
  await fetchInChunks(store, claims, fillKey, async (imageRefs) => {
    const data = await callFigma(client, "figma.file.imageFills.request", { fileKey, imageRefs });
    return data.images;
  });
}

async function fetchRasters(
  client: DaemonClient,
  store: PrototypeAssetStore,
  fileKey: string,
  version: string,
  claims: RefClaim[],
  spec: RasterSpec,
  quality: boolean,
): Promise<void> {
  // Pin the snapshot on EVERY chunk: the daemon's versioned cache is what makes these bytes
  // historical rather than "latest" (a live-link drift could otherwise paint newer bytes into
  // an older frame). The fidelity fields ride ONLY on the quality path: the daemon refuses
  // format=svg/useAbsoluteBounds without an explicit version, and pre-capability hosts never
  // see fields their schema would reject.
  await fetchInChunks(
    store,
    claims,
    (id) => rasterKey(id, version, spec),
    async (ids) => {
      const data = await callFigma(client, "figma.file.render.request", {
        fileKey,
        ids,
        scale: spec.scale,
        version,
        ...(quality
          ? {
              format: spec.format,
              ...(spec.bounds === "absolute" ? { useAbsoluteBounds: true } : {}),
            }
          : {}),
      });
      return data.images;
    },
  );
}

// Per-instance identity so a reused FrameContent navigating between roots owns distinct claim
// sets — the old root's assets must be releasable while the new root keeps whatever it shares.
let frameContentSequence = 0;

// The one TEXT raster class (ADR-0042): Figma-exported outlined glyphs at scale 1, mapped onto
// the node's absoluteBoundingBox. Vector bytes — crisp at any player zoom, no font dependency.
const TEXT_SVG_SPEC: RasterSpec = { scale: 1, format: "svg", bounds: "absolute" };

export function FrameContent({ file, root, scale, overrides }: FrameContentProps) {
  const client = useHostRuntimeClient(file.serverId);
  const scope = usePrototypeAssetScope();
  const store = scope?.store ?? null;
  const fontGate = scope?.fontGate ?? null;
  // ADR-0042 quality path: host capability + the player's always-pinned snapshot scope. Without
  // either — or with an empty/whitespace pin the daemon would refuse the new fields for —
  // rasters stay the exact legacy scale-2 crop PNG on the wire.
  const fidelity = useHostFeature(file.serverId, "figmaRenderFidelity");
  const quality = fidelity === true && scope !== null && isPinnedVersion(scope.version);
  // Node types the renderer revealed through `fallbackForNode(id, nodeType)` — only ids KNOWN
  // to be TEXT take the SVG route; everything else is default-crop PNG on the adaptive rung.
  const nodeTypes = useRef(new Map<string, "TEXT" | "OTHER">());
  // Persistent per-node downgrade channel `${nodeId}@${version}` (ADR-0042): once a TEXT node's
  // SVG entry failed terminal, EVERY later read and fetch routes to the absolute-bounds PNG —
  // independent of the SVG entry's own retention, so the store reconciling it away cannot
  // restart the SVG and ping-pong per paint. The PNG itself is finite per (node, version, rung)
  // by cache identity: one claim per rung (zoom asks each new rung exactly once, ≤4 rungs), the
  // rung's failed entry is the negative cache, and only a scope/version change resets it.
  const downgradedText = useRef(new Set<string>());
  const textPngOnce = useRef(new Set<string>());
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [assetsReady, setAssetsReady] = useState(0);
  const renderer = useMemo(() => createFigmaRenderer(), []);
  const onMissingRef = useRef<(missing: MissingAssets) => void>(() => {});

  // The rung the player actually paints at: zoom scale × device px, quantized 1..4. Memoized
  // per (quality, scale) so `fallbackForNode` can name it in its deps and stay stable between
  // renders that do not change the draw geometry.
  const cropSpec = useCallback(
    (): RasterSpec =>
      quality
        ? {
            scale: rasterRung(scale * (window.devicePixelRatio || 1)),
            format: "png",
            bounds: "crop",
          }
        : { scale: 2, format: "png", bounds: "crop" },
    [quality, scale],
  );

  // ONE routing decision shared by the draw reads (fallbackForNode) and the fetches
  // (onMissing), so a read can never miss the cache its fetch went into — and a downgraded
  // TEXT never re-enters the SVG class (no per-paint ping-pong, root review bug 2).
  const routeSpecFor = useCallback(
    (nodeId: string, version: string): RasterSpec => {
      if (quality && nodeTypes.current.get(nodeId) === "TEXT") {
        if (downgradedText.current.has(`${nodeId}@${version}`))
          return { scale: cropSpec().scale, format: "png", bounds: "absolute" };
        return TEXT_SVG_SPEC;
      }
      return cropSpec();
    },
    [quality, cropSpec],
  );

  const instanceIdRef = useRef<number | null>(null);
  if (instanceIdRef.current === null) instanceIdRef.current = ++frameContentSequence;
  const ownerId = `${instanceIdRef.current}:${root.id}`;
  const heldOwnersRef = useRef<Set<string>>(new Set());
  heldOwnersRef.current.add(ownerId);

  const requiredFonts = useMemo(() => collectRequiredFonts(root), [root]);

  // Font loading runs IN PARALLEL with drawing (W8 5d0b57396: the renderer paints TEXT as a real
  // Figma raster while a face is in flight), so a hung font request can never hold the
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
    // Record the renderer's TEXT classification FIRST, then split the asks through the ONE
    // route helper: known TEXT rides the outlined-SVG cache (or its persistent PNG channel once
    // downgraded), everything else stays default-crop PNG (adaptive rung with the capability,
    // legacy scale 2 without). `claim` keeps each class single-flight per dimensioned key, and
    // same-spec ids share one batch.
    for (const id of missing.textFallbackNodeIds ?? []) nodeTypes.current.set(id, "TEXT");
    const bySpec = new Map<string, { spec: RasterSpec; claims: RefClaim[] }>();
    for (const id of missing.fallbackNodeIds) {
      const spec =
        quality && nodeTypes.current.get(id) === "TEXT"
          ? routeSpecFor(id, scope.version)
          : cropSpec();
      const ns = `${spec.scale}@${spec.format}@${spec.bounds}`;
      const claim = store.claim(ownerId, rasterKey(id, scope.version, spec));
      if (!claim) continue;
      const group = bySpec.get(ns) ?? { spec, claims: [] };
      group.claims.push({ id, claim });
      bySpec.set(ns, group);
    }
    if (imageClaims.length > 0) {
      void fetchFills(client, store, file.fileKey, imageClaims).catch(() => undefined);
    }
    for (const { spec, claims } of bySpec.values()) {
      void fetchRasters(client, store, file.fileKey, scope.version, claims, spec, quality).catch(
        () => undefined,
      );
    }
    if (missing.fonts.length > 0 && fontGate) {
      // Bounded by construction: the gate singleflights per family and remembers failed
      // attempts for its lifetime. Repaint only when a face actually became
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
    (nodeId: string, nodeType?: string) => {
      if (!store || !scope) return null;
      if (nodeType) nodeTypes.current.set(nodeId, nodeType === "TEXT" ? "TEXT" : "OTHER");
      const isQualityText = quality && nodeTypes.current.get(nodeId) === "TEXT";
      const spec = routeSpecFor(nodeId, scope.version);
      const key = rasterKey(nodeId, scope.version, spec);
      const entry = store.get(key);
      if (!entry) return null; // never claimed: onMissing starts the first fetch
      // Cache hit IS use: attach this owner so a releasing frame cannot free bytes still
      // painted — including FAILED entries, whose retention as a negative cache is what makes
      // the route finite (no refetch per paint).
      store.attachOwner(ownerId, key);
      if (!isQualityText || entry.status !== "failed") return entry.image;
      // Terminal SVG failure → engage the persistent downgrade channel: every later read and
      // fetch for this node+snapshot routes to the absolute-bounds PNG at the CURRENT rung.
      // Each rung is claimed exactly once (finite 1..4 lattice); the rung's own failed entry
      // is the negative cache afterwards.
      downgradedText.current.add(`${nodeId}@${scope.version}`);
      const pngSpec = routeSpecFor(nodeId, scope.version);
      const pngKey = rasterKey(nodeId, scope.version, pngSpec);
      const onceKey = `${nodeId}@${scope.version}@${pngSpec.scale}`;
      if (!textPngOnce.current.has(onceKey) && client) {
        textPngOnce.current.add(onceKey);
        const claim = store.claim(ownerId, pngKey);
        if (claim) {
          void fetchRasters(
            client,
            store,
            file.fileKey,
            scope.version,
            [{ id: nodeId, claim }],
            pngSpec,
            true,
          ).catch(() => undefined);
        }
      }
      const png = store.get(pngKey);
      if (png) store.attachOwner(ownerId, pngKey);
      return png?.image ?? null;
    },
    // routeSpecFor is stable per (quality, scale) and carries the rung, so the callback only
    // changes when the draw geometry or scope can change; `scale` itself is reached through it.
    [store, ownerId, scope, quality, client, file.fileKey, routeSpecFor],
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
      // ADR-0042 bounds pairing: the quality path delivers known-TEXT fallbacks as absolute-
      // bounds bytes, so the renderer places those on the layout box; every other fallback is
      // Figma's default crop and must land on absoluteRenderBounds (renderer-side rule).
      fallbackTextUsesAbsoluteBounds: quality,
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
    quality,
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
