import { useMemo } from "react";
import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import { useFetchQueries } from "@/data/query";
import { callFigma, figmaKeys } from "./figma-api";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { FigmaFileRef } from "@/figma/contracts";

// Frame subtrees for the player (`figma.file.nodes`, spec 32.5.1/32.5.3). One query per node id
// so visiting more frames never refetches the ones already on hand; the cache key carries the
// version, so subtrees are immutable entries.

export interface FrameLookup {
  nodeFor: (nodeId: string) => FigmaNode | null;
  loading: boolean;
  error: string | null;
}

export function useFigmaFrames(file: FigmaFileRef, ids: readonly string[]): FrameLookup {
  const client = useHostRuntimeClient(file.serverId);
  const uniqueIds = useMemo(() => Array.from(new Set(ids)), [ids]);
  const version = file.version ?? null;
  const queries = useFetchQueries(
    uniqueIds.map((nodeId) => ({
      queryKey: figmaKeys.node(file.serverId, file.fileKey, version, nodeId),
      queryFn: async (): Promise<FigmaNode> => {
        const data = await callFigma(client, "figma.file.nodes.request", {
          fileKey: file.fileKey,
          ids: [nodeId],
          version: file.version,
        });
        const node = data.nodes[nodeId];
        if (!node) throw new Error(`Node ${nodeId} is not in this file.`);
        return node;
      },
      enabled: client !== null,
      dataShape: "value" as const,
      staleTimeMs: 24 * 60 * 60 * 1000,
    })),
  );
  const nodes = useMemo(
    () => new Map(uniqueIds.map((id, index) => [id, queries[index]?.data ?? null])),
    [uniqueIds, queries],
  );
  const failed = queries.find((query) => query.error !== null);
  return {
    nodeFor: (nodeId) => nodes.get(nodeId) ?? null,
    loading: uniqueIds.length > 0 && queries.some((query) => query.isPending),
    error: failed ? (failed.error?.message ?? "Failed to load a frame.") : null,
  };
}
