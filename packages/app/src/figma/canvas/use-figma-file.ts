import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  FigmaBytes,
  FigmaComponentMeta,
  FigmaEditOp,
  FigmaFile,
  FigmaNode,
  FigmaPendingOp,
} from "@jagentdesk/protocol/figma/rpc-schemas";
import { useFetchQuery } from "@/data/query";
import { getHostRuntimeStore, useHostRuntimeClient } from "@/runtime/host-runtime";
import { callFigma } from "./api";
import { dropFrameStores, FrameStore, getFrameStore } from "./frame-store";
import { pendingToOverrides } from "./pending-overrides";

// Data hooks for the file screen (spec 32.5). Keys start with ["figma", serverId, fileKey] so a
// file's state drops at once. Live updates arrive from figma.file.changed / figma.link.changed /
// figma.pending.changed — nothing polls on a timer except the daemon-side meta check (32.8).

export const figmaKeys = {
  all: (serverId: string, fileKey: string) => ["figma", serverId, fileKey] as const,
  outline: (serverId: string, fileKey: string, version: string | null) =>
    [...figmaKeys.all(serverId, fileKey), "outline", version ?? "live"] as const,
  files: (serverId: string) => ["figma", serverId, "files"] as const,
  linkStatus: (serverId: string) => ["figma", serverId, "link-status"] as const,
  pending: (serverId: string, fileKey: string) =>
    [...figmaKeys.all(serverId, fileKey), "pending"] as const,
};

export function useFigmaOutline(serverId: string, fileKey: string, version: string | null) {
  const client = useHostRuntimeClient(serverId);
  return useFetchQuery({
    queryKey: figmaKeys.outline(serverId, fileKey, version),
    queryFn: async () => {
      const { outline } = await callFigma(client, "figma.file.outline.request", {
        fileKey,
        ...(version ? { version } : {}),
      });
      if (!outline) throw new Error("This file is unavailable.");
      return outline;
    },
    enabled: client !== null,
    dataShape: "value",
    staleTimeMs: 60_000,
  });
}

/** The shared lazy subtree store; a new store per version so snapshots never mix with live data. */
export function useFigmaFrameStore(
  serverId: string,
  fileKey: string,
  version: string | null,
  reloadToken: number,
): FrameStore | null {
  const client = useHostRuntimeClient(serverId);
  return useMemo(() => {
    if (!client) return null;
    return getFrameStore(
      `${serverId}|${reloadToken}`,
      fileKey,
      version ?? undefined,
      async (ids) => {
        const data = await client.figmaRequest("figma.file.nodes.request", {
          fileKey,
          ids: [...ids],
          ...(version ? { version } : {}),
        });
        if (data.error) throw new Error(data.error.message);
        return {
          nodes: data.nodes as Record<string, FigmaNode | null>,
          components: (data.components ?? {}) as Record<string, FigmaComponentMeta>,
        };
      },
    );
  }, [client, serverId, fileKey, version, reloadToken]);
}

/** Subscribe the component to the store and kick loading; returns nothing — read via store.get. */
export function useFrameLoader(store: FrameStore | null, ids: readonly string[]): void {
  const key = ids.join(",");
  // The subscribe callback must be stable across renders: an inline arrow changes identity every
  // render, and useSyncExternalStore then tears down and re-adds the listener on every paint tick.
  const subscribe = useCallback(
    (onChange: () => void) => (store ? store.subscribe(onChange) : () => undefined),
    [store],
  );
  // Key the snapshot on the store's monotonic revision, not loadedCount(): at LRU capacity a
  // replacement keeps the count equal, React sees no change, and the canvas never repaints.
  const snapshot = useSyncExternalStore(
    subscribe,
    () => (store ? store.revisionSnapshot() : 0),
    () => 0,
  );
  useEffect(() => {
    if (!store || key.length === 0) return;
    void store.load(key.split(","));
  }, [store, key]);
  void snapshot;
}

/** Registers a file watch while the screen is open and reloads visible data on figma.file.changed. */
export function useFigmaWatch(input: {
  serverId: string;
  fileKey: string;
  active: boolean;
  onChanged: (version: string, source: "rest" | "link") => void;
}): void {
  const { serverId, fileKey, active, onChanged } = input;
  const client = useHostRuntimeClient(serverId);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  useEffect(() => {
    if (!client || !active) return;
    let watchId: string | null = null;
    let closed = false;
    const off = client.onFigmaPush("figma.file.changed", (message) => {
      if (watchId !== null && message.watchId !== watchId) return;
      onChangedRef.current(message.version, message.source);
    });
    void client
      .figmaRequest("figma.file.watch.request", { fileKey })
      .then((payload) => {
        if (closed) {
          void client.figmaRequest("figma.file.unwatch.request", { watchId: payload.watchId });
          return null;
        }
        watchId = payload.watchId;
        return payload.watchId;
      })
      .catch(() => undefined);
    return () => {
      closed = true;
      off();
      if (watchId !== null) {
        void client.figmaRequest("figma.file.unwatch.request", { watchId }).catch(() => undefined);
      }
    };
  }, [client, active, fileKey]);
}

/** Files known to the daemon, so the screen learns whether this one is linked (32.1). */
export function useFigmaLinked(serverId: string, fileKey: string): boolean {
  const client = useHostRuntimeClient(serverId);
  const query = useFetchQuery({
    queryKey: figmaKeys.files(serverId),
    queryFn: async () => (await callFigma(client, "figma.files.list.request", {})).files,
    enabled: client !== null,
    dataShape: "list",
    staleTimeMs: 10_000,
  });
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!client) return;
    return client.onFigmaPush("figma.link.changed", () => {
      void queryClient.invalidateQueries({ queryKey: figmaKeys.files(serverId) });
    });
  }, [client, serverId, queryClient]);
  const file = useMemo<FigmaFile | undefined>(
    () => query.data?.find((candidate) => candidate.fileKey === fileKey),
    [query.data, fileKey],
  );
  return file?.linked === true;
}

/** The edit queue for this file (32.6.1), refreshed by figma.pending.changed. */
export function useFigmaPendingOps(serverId: string, fileKey: string): FigmaPendingOp[] {
  const client = useHostRuntimeClient(serverId);
  const query = useFetchQuery({
    queryKey: figmaKeys.pending(serverId, fileKey),
    queryFn: async () => (await callFigma(client, "figma.pending.list.request", { fileKey })).ops,
    enabled: client !== null,
    dataShape: "list",
    staleTimeMs: 5_000,
  });
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!client) return;
    return client.onFigmaPush("figma.pending.changed", (message) => {
      if (message.fileKey !== fileKey) return;
      void queryClient.invalidateQueries({ queryKey: figmaKeys.pending(serverId, fileKey) });
    });
  }, [client, serverId, fileKey, queryClient]);
  return query.data ?? [];
}

export interface FigmaEdits {
  linked: boolean;
  pendingOps: FigmaPendingOp[];
  pendingCount: number;
  /** Bumps whenever an edit lands, so the canvas rebuilds its frame store and re-draws. */
  reloadToken: number;
  /** Canvas overrides for queued edits (32.6.1). */
  overrides: Record<string, Partial<FigmaNode>>;
  /** 32.6: through Figma Link when the file is open there, otherwise into the queue. */
  applyEdits: (ops: FigmaEditOp[]) => Promise<void>;
  /** Ask the daemon to drain the queue through a now-connected Link. */
  applyPending: () => Promise<void>;
  discardPending: () => Promise<void>;
}

export function useFigmaEdits(serverId: string, fileKey: string): FigmaEdits {
  const client = useHostRuntimeClient(serverId);
  const queryClient = useQueryClient();
  const linked = useFigmaLinked(serverId, fileKey);
  const pendingOps = useFigmaPendingOps(serverId, fileKey);
  const [reloadToken, setReloadToken] = useState(0);

  const applyEdits = useCallback(
    async (ops: FigmaEditOp[]) => {
      if (!client) throw new Error("The host is offline.");
      if (ops.length === 0) return;
      if (linked) {
        const data = await callFigma(client, "figma.link.op.request", { fileKey, ops });
        const failed = data.results.find((result) => !result.ok);
        if (failed?.message) throw new Error(failed.message);
      } else {
        await callFigma(client, "figma.pending.add.request", { fileKey, ops });
      }
      void queryClient.invalidateQueries({ queryKey: figmaKeys.pending(serverId, fileKey) });
      setReloadToken((token) => token + 1);
    },
    [client, linked, fileKey, queryClient, serverId],
  );

  const applyPending = useCallback(async () => {
    if (!client) return;
    await callFigma(client, "figma.pending.apply.request", { fileKey });
    void queryClient.invalidateQueries({ queryKey: figmaKeys.pending(serverId, fileKey) });
    setReloadToken((token) => token + 1);
  }, [client, fileKey, queryClient, serverId]);

  const discardPending = useCallback(async () => {
    if (!client) return;
    await callFigma(client, "figma.pending.discard.request", { fileKey });
    void queryClient.invalidateQueries({ queryKey: figmaKeys.pending(serverId, fileKey) });
    setReloadToken((token) => token + 1);
  }, [client, fileKey, queryClient, serverId]);

  const overrides = useMemo(() => pendingToOverrides(pendingOps), [pendingOps]);

  return {
    linked,
    pendingOps,
    pendingCount: pendingOps.filter((entry) => entry.state === "pending").length,
    reloadToken,
    overrides,
    applyEdits,
    applyPending,
    discardPending,
  };
}

/** Bytes for a node export (32.5.2): the app receives bytes, never a Figma URL (32.8). */
export async function fetchFigmaExport(
  serverId: string,
  fileKey: string,
  nodeId: string,
  format: "png" | "jpg" | "svg" | "pdf",
  scale: number,
): Promise<{ file: FigmaBytes | null; fileName: string | null }> {
  const client = getHostRuntimeStore().getSnapshot(serverId)?.client ?? null;
  return callFigma(client, "figma.file.export.request", { fileKey, nodeId, format, scale });
}

/** Clear every cached subtree for a file (new version reported by figma.file.changed). */
export function invalidateFigmaFile(serverId: string, fileKey: string): void {
  dropFrameStores("*", fileKey);
}
