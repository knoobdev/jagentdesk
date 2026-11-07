import { useCallback, useMemo, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import {
  getHostRuntimeStore,
  useHostRuntimeClient,
  useHostRuntimeConnectionStatus,
  type HostRuntimeConnectionStatus,
} from "@/runtime/host-runtime";
import { callFigma, FigmaHostOfflineError } from "./api";
import { waitForFigmaHost } from "./page-outline-retry";
import { pageOutlineKeys, readOutlineSnapshot, type ReadParams } from "./page-outline-cache";

function outlineLoadError(
  retry: Error | null,
  index: Error | null,
  page: Error | null,
  status: HostRuntimeConnectionStatus,
): Error | null {
  return (
    retry ??
    index ??
    page ??
    (status === "offline" || status === "error" ? new FigmaHostOfflineError() : null)
  );
}

// Mounted only behind the figmaPagedOutline gate. Both sidebar and canvas use this hook and
// identical keys, so neither starts a legacy full-file read or owns another copy of the index.
export function useFigmaPageOutline(
  serverId: string,
  fileKey: string,
  version: string | null,
  requestedPageId: string | null,
) {
  const client = useHostRuntimeClient(serverId);
  const connectionStatus = useHostRuntimeConnectionStatus(serverId);
  const queries = useQueryClient();
  const load = async (params: ReadParams) => {
    const { outline } = await callFigma(
      getHostRuntimeStore().getSnapshot(serverId)?.client ?? null,
      "figma.file.outline.request",
      params,
    );
    if (!outline) throw new Error("This file is unavailable.");
    return outline;
  };
  const indexKey = useMemo(
    () => pageOutlineKeys.index(serverId, fileKey, version),
    [serverId, fileKey, version],
  );
  const index = useFetchQuery({
    queryKey: indexKey,
    queryFn: () =>
      readOutlineSnapshot(
        queries,
        indexKey,
        {
          fileKey,
          pagesOnly: true,
          ...(version ? { version } : {}),
        },
        load,
      ),
    enabled: client !== null,
    dataShape: "value",
    staleTimeMs: 60_000,
    retry: false,
  });
  const selectedId = requestedPageId ?? index.data?.pages[0]?.id ?? null;
  const pinned = index.data?.version ?? null;
  const pageExists = Boolean(index.data?.pages.some((page) => page.id === selectedId));
  const pageKey = useMemo(
    () => pageOutlineKeys.page(serverId, fileKey, pinned, selectedId),
    [serverId, fileKey, pinned, selectedId],
  );
  const page = useFetchQuery({
    queryKey: pageKey,
    queryFn: () =>
      readOutlineSnapshot(
        queries,
        pageKey,
        {
          fileKey,
          pageId: selectedId!,
          version: pinned!,
        },
        load,
      ),
    enabled: client !== null && pinned !== null && pageExists,
    dataShape: "value",
    staleTimeMs: 30 * 60_000,
    retry: false,
  });
  const data = useMemo(() => {
    if (!index.data) return undefined;
    const selected =
      page.data?.version === index.data.version
        ? page.data.pages.find((entry) => entry.id === selectedId && entry.childrenLoaded === true)
        : undefined;
    return selected
      ? {
          ...index.data,
          pages: index.data.pages.map((entry) => (entry.id === selected.id ? selected : entry)),
        }
      : index.data;
  }, [index.data, page.data, selectedId]);
  const refetchIndex = index.refetch;
  const refetchPage = page.refetch;
  const indexAvailable = Boolean(index.data && !index.error);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<Error | null>(null);
  const retryAbort = useRef<AbortController | null>(null);
  const scope = JSON.stringify([serverId, fileKey, version, pinned, selectedId]);
  const retryScope = useRef<string | null>(scope);
  retryScope.current = scope;
  useEffect(() => {
    retryScope.current = scope;
    setRetrying(false);
    setRetryError(null);
    return () => {
      if (retryScope.current === scope) retryScope.current = null;
      retryAbort.current?.abort();
    };
  }, [scope]);
  const refetch = useCallback(async () => {
    if (retryAbort.current && !retryAbort.current.signal.aborted) return;
    const abort = new AbortController();
    retryAbort.current = abort;
    setRetrying(true);
    setRetryError(null);
    try {
      await waitForFigmaHost(getHostRuntimeStore(), serverId, abort.signal);
      if (retryScope.current !== scope) return;
      await queries.cancelQueries({ queryKey: indexAvailable ? pageKey : indexKey, exact: true });
      if (retryScope.current !== scope) return;
      return indexAvailable ? await refetchPage() : await refetchIndex();
    } catch (error) {
      if (retryScope.current === scope)
        setRetryError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      abort.abort();
      if (retryAbort.current === abort) retryAbort.current = null;
      if (retryScope.current === scope) setRetrying(false);
    }
  }, [serverId, scope, indexAvailable, refetchIndex, refetchPage, queries, indexKey, pageKey]);
  const error = outlineLoadError(retryError, index.error, page.error, connectionStatus);
  const isPending = !error && (index.isPending || (pageExists && page.isPending));
  return {
    data,
    error,
    isError: Boolean(error),
    isPending,
    isLoading: isPending,
    retrying,
    isFetching: retrying || index.isFetching || page.isFetching,
    refetch,
  };
}
