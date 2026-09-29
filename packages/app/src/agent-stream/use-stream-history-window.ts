import { useCallback, useEffect, useMemo, useState } from "react";
import type { StreamItem } from "@/types/stream";
import { findMountedWindowStart, getMountedRecentStreamItems } from "./history-window";

// Callers reveal a message. In this timeline a message is one row, so the row id is the message id.
function findMessageRowIndex(items: StreamItem[], messageId: string): number {
  return items.findIndex((item) => item.id === messageId);
}

function findEarlierHistoryWindowStart(input: {
  items: StreamItem[];
  start: number;
  itemId: string | undefined;
}): number {
  const targetIndex = input.itemId ? findMessageRowIndex(input.items, input.itemId) : -1;
  const targetStart = targetIndex >= 0 && targetIndex < input.start ? targetIndex : input.start;
  if (!input.itemId) {
    return findMountedWindowStart({
      items: input.items.slice(0, targetStart),
      minMountedCount: getMountedRecentStreamItems(),
    });
  }
  return findMountedWindowStart({
    items: input.items.slice(0, targetStart + 1),
    minMountedCount: 1,
  });
}

interface HistoryWindowBoundary {
  agentId: string;
  boundaryItemId: string | null;
  initialized: boolean;
}

function reconcileHistoryWindow(input: {
  current: HistoryWindowBoundary;
  agentId: string;
  boundaryIndex: number;
  initialBoundaryItemId: string | null;
  hasItems: boolean;
}): HistoryWindowBoundary {
  const { current, agentId, boundaryIndex, initialBoundaryItemId, hasItems } = input;
  if (current.agentId !== agentId) {
    return { agentId, boundaryItemId: initialBoundaryItemId, initialized: hasItems };
  }
  if (!current.initialized && hasItems) {
    return { ...current, boundaryItemId: initialBoundaryItemId, initialized: true };
  }
  if (current.boundaryItemId !== null && boundaryIndex < 0) {
    return { ...current, boundaryItemId: initialBoundaryItemId };
  }
  return current;
}

export function useStreamHistoryWindow(input: {
  agentId: string;
  items: StreamItem[];
  loadRemoteOlder: () => boolean | Promise<boolean>;
}) {
  const { agentId, items, loadRemoteOlder } = input;
  const initialStart = useMemo(
    () => findMountedWindowStart({ items, minMountedCount: getMountedRecentStreamItems() }),
    [items],
  );
  const initialBoundaryItemId = initialStart === 0 ? null : (items[initialStart]?.id ?? null);
  const [window, setWindow] = useState(() => ({
    agentId,
    boundaryItemId: initialBoundaryItemId,
    initialized: items.length > 0,
  }));
  const boundaryIndex =
    window.agentId === agentId && window.boundaryItemId !== null
      ? items.findIndex((item) => item.id === window.boundaryItemId)
      : -1;
  let start = initialStart;
  if (window.agentId === agentId && window.initialized) {
    if (window.boundaryItemId === null) {
      start = 0;
    } else if (boundaryIndex >= 0) {
      start = boundaryIndex;
    }
  }

  useEffect(() => {
    setWindow((current) =>
      reconcileHistoryWindow({
        current,
        agentId,
        boundaryIndex,
        initialBoundaryItemId,
        hasItems: items.length > 0,
      }),
    );
  }, [agentId, boundaryIndex, initialBoundaryItemId, items.length]);

  const revealLoadedHistory = useCallback(
    (itemId?: string): boolean => {
      const targetIndex = itemId ? findMessageRowIndex(items, itemId) : -1;
      if (start === 0 || (itemId !== undefined && (targetIndex < 0 || targetIndex >= start))) {
        return false;
      }
      const nextStart = findEarlierHistoryWindowStart({ items, start, itemId });
      if (nextStart === start) {
        return false;
      }
      setWindow({
        agentId,
        boundaryItemId: items[nextStart]?.id ?? null,
        initialized: true,
      });
      return true;
    },
    [agentId, items, start],
  );
  const loadOlder = useCallback(async (): Promise<boolean> => {
    return revealLoadedHistory() || (await loadRemoteOlder());
  }, [loadRemoteOlder, revealLoadedHistory]);

  return { start, hasLocalHistory: start > 0, revealLoadedHistory, loadOlder };
}

export interface RemoteHistoryPagination {
  isLoadingOlder: boolean;
  hasOlder: boolean;
  progressKey: string | null;
  loadOlder: () => boolean | Promise<boolean>;
}

/**
 * Combines daemon pagination with the local history window: older rows that are already loaded
 * are revealed first, and only then is the daemon asked for more.
 */
export function useWindowedHistoryPagination(input: {
  agentId: string;
  items: StreamItem[];
  remote: RemoteHistoryPagination;
}) {
  const { remote } = input;
  const { start, hasLocalHistory, revealLoadedHistory, loadOlder } = useStreamHistoryWindow({
    agentId: input.agentId,
    items: input.items,
    loadRemoteOlder: remote.loadOlder,
  });
  return {
    historyStart: start,
    revealLoadedHistory,
    loadOlder,
    isLoadingOlder: remote.isLoadingOlder,
    hasOlder: hasLocalHistory || remote.hasOlder,
    progressKey: `${remote.progressKey ?? "local"}:${start}`,
  };
}
