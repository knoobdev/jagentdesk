import { useMemo } from "react";
import type {
  FigmaInteraction,
  FigmaNode,
  FigmaPrototype,
  FigmaResponseData,
} from "@jagentdesk/protocol/figma/rpc-schemas";
import { useFetchQueries } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { FigmaFileRef } from "@/figma/contracts";
import { callFigma, figmaKeys } from "./figma-api";

// ADR-0037: playback reads the frames still on stage — the base, open overlays, and the two
// frames of a running transition — from the daemon's versioned cache, never the full prototype
// RPC. Batches stay under the protocol's 10-id ceiling; `gcTime: 0` releases subtree data the
// moment it leaves the stage, so memory tracks what is visible, not how far Back has walked.
// Re-entering a frame re-observes its query and the daemon serves the same immutable version
// from disk — the player never holds the Back stack's trees in memory.

const BATCH_SIZE = 10;
const PLAYBACK_STALE_MS = 24 * 60 * 60 * 1000;

// The protocol exports the prototype's type only; overlay settings are its element, so derive
// it here rather than restating the shape (one fact, one source).
type FigmaOverlaySettings = FigmaPrototype["overlays"][number];

// Stable numeric ids for response objects, so the derived-lookup memo can tell two payloads
// apart even when they land in the same millisecond (`dataUpdatedAt` alone lies twice over:
// equal timestamps across batches, and refetches that replace data within one ms).
const dataIds = new WeakMap<object, number>();
let dataIdSeq = 0;

function dataIdentity(data: unknown): string {
  if (data === null || typeof data !== "object") return String(data);
  let id = dataIds.get(data);
  if (id === undefined) {
    id = ++dataIdSeq;
    dataIds.set(data, id);
  }
  return String(id);
}

export interface FrameLookup {
  nodeFor: (nodeId: string) => FigmaNode | null;
  loading: boolean;
  error: string | null;
  /** Merged metadata of the loaded batches; null until any batch has landed. */
  prototype: FigmaPrototype | null;
  retry: () => void;
}

type PlaybackData = FigmaResponseData<"figma.file.playback.request">;

export function useFigmaFrames(
  file: FigmaFileRef,
  ids: readonly string[],
  version: string,
): FrameLookup {
  const client = useHostRuntimeClient(file.serverId);
  const textOutlines = useHostFeature(file.serverId, "figmaTextOutlines");
  const batches = useMemo(() => {
    // Sorted so the same visible set always produces the same query keys — a reshuffle of the
    // player state must not force every batch to refetch.
    const unique = [...new Set(ids)].sort();
    const result: string[][] = [];
    for (let i = 0; i < unique.length; i += BATCH_SIZE)
      result.push(unique.slice(i, i + BATCH_SIZE));
    return result;
  }, [ids]);

  const queries = useFetchQueries<PlaybackData>(
    batches.map((frameIds) => ({
      queryKey: [
        ...figmaKeys.file(file.serverId, file.fileKey, version),
        "playback",
        frameIds.join(","),
      ],
      queryFn: () =>
        callFigma(client, "figma.file.playback.request", {
          fileKey: file.fileKey,
          frameIds,
          version,
          ...(textOutlines ? { prepareTextOutlines: true } : {}),
        }),
      enabled: client !== null,
      dataShape: "value" as const,
      staleTimeMs: PLAYBACK_STALE_MS,
      gcTime: 0,
    })),
  );

  // Rebuild the lookup only when a batch's result actually changes: a fresh `prototype`/`nodes`
  // object every render would reindex interactions every render, invalidate the player's
  // dispatch callback, and starve every timer that depends on it. The query key carries the
  // server/file/version and the exact id set, so a re-chunk or a version swap can never reuse
  // the previous snapshot's merge, and `dataIdentity` catches a payload replaced in-flight.
  const signature = queries
    .map(
      (query, index) =>
        `${file.serverId}|${file.fileKey}|${version}|${batches[index]?.join(",") ?? ""}\u0000${query.dataUpdatedAt}\u0000${query.error?.message ?? ""}\u0000${dataIdentity(query.data ?? null)}`,
    )
    .join("\u0001");
  const derived = useMemo(() => {
    const nodes = new Map<string, FigmaNode>();
    const interactions: FigmaInteraction[] = [];
    const seenInteractions = new Set<string>();
    const overlays = new Map<string, FigmaOverlaySettings>();
    let prototype: FigmaPrototype | null = null;
    let overlaySettingsAvailable = true;
    for (const query of queries) {
      const data = query.data;
      if (!data) continue;
      for (const [id, node] of Object.entries(data.frames)) nodes.set(id, node);
      const meta = data.prototype;
      if (!meta) {
        overlaySettingsAvailable = false;
        prototype ??= {
          flows: [],
          interactions: [],
          overlays: [],
          overlaySettingsAvailable: false,
        };
        continue;
      }
      prototype ??= { flows: [], interactions: [], overlays: [], overlaySettingsAvailable: true };
      for (const raw of meta.interactions) {
        const key = JSON.stringify(raw);
        if (seenInteractions.has(key)) continue;
        seenInteractions.add(key);
        interactions.push(raw);
      }
      for (const overlay of meta.overlays) overlays.set(overlay.frameId, overlay);
      overlaySettingsAvailable &&= meta.overlaySettingsAvailable;
    }
    if (prototype) {
      prototype.interactions = interactions;
      prototype.overlays = [...overlays.values()];
      prototype.overlaySettingsAvailable = overlaySettingsAvailable;
    }
    return {
      nodeFor: (nodeId: string) => nodes.get(nodeId) ?? null,
      prototype,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const failed = queries.find((query) => query.error !== null);
  const error =
    failed?.error?.message ??
    (client === null && batches.length > 0 ? "The host is offline." : null);
  return {
    nodeFor: derived.nodeFor,
    loading:
      batches.length > 0 &&
      client !== null &&
      queries.some((query) => query.isPending && query.fetchStatus !== "idle"),
    error,
    prototype: derived.prototype,
    retry: () => {
      for (const query of queries) if (query.error !== null) void query.refetch();
    },
  };
}
