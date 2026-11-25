import { useSessionStore } from "@/stores/session-store";
import { useMemo } from "react";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useReplicaQuery } from "@/data/query";
import { checkoutDiffPushRoute } from "@/data/push-router";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { ParsedDiffFile, SubscribeCheckoutDiffResponse } from "@jagentdesk/protocol/messages";
import { checkoutDiffQueryKey } from "@/git/query-keys";

interface UseCheckoutDiffQueryOptions {
  serverId: string;
  cwd: string;
  mode: "uncommitted" | "base" | "all";
  baseRef?: string;
  ignoreWhitespace?: boolean;
  enabled?: boolean;
  queryScope?: string;
}

type CheckoutDiffQueryPayload = Omit<SubscribeCheckoutDiffResponse["payload"], "subscriptionId">;

// Re-export the canonical protocol type so all consumers share one definition.
export type { ParsedDiffFile };
export type DiffHunk = ParsedDiffFile["hunks"][number];
export type DiffLine = DiffHunk["lines"][number];
export type HighlightToken = NonNullable<DiffLine["tokens"]>[number];

function normalizeCheckoutDiffCompare(compare: {
  mode: "uncommitted" | "base" | "all";
  baseRef?: string;
  ignoreWhitespace?: boolean;
}): { mode: "uncommitted" | "base" | "all"; baseRef?: string; ignoreWhitespace?: boolean } {
  const ignoreWhitespace = compare.ignoreWhitespace === true;
  if (compare.mode === "uncommitted") {
    return { mode: "uncommitted", ignoreWhitespace };
  }
  const trimmedBaseRef = compare.baseRef?.trim();
  return trimmedBaseRef
    ? { mode: compare.mode, baseRef: trimmedBaseRef, ignoreWhitespace }
    : { mode: compare.mode, ignoreWhitespace };
}

export function useCheckoutDiffQuery({
  serverId,
  cwd,
  mode,
  baseRef,
  ignoreWhitespace,
  enabled = true,
  queryScope,
}: UseCheckoutDiffQueryOptions) {
  // COMPAT(checkoutDiffAll): added in v0.9.59, remove after 2027-05-23 once host floor includes All changes.
  const allSupported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.checkoutDiffAll === true,
  );
  const requiresUpdate = mode === "all" && !allSupported;
  const retainedPanelActive = useRetainedPanelActive();
  const queryEnabled = enabled && retainedPanelActive;
  const isConnected = useHostRuntimeIsConnected(serverId);
  const normalizedCompare = useMemo(
    () => normalizeCheckoutDiffCompare({ mode, baseRef, ignoreWhitespace }),
    [mode, baseRef, ignoreWhitespace],
  );
  const compareMode = normalizedCompare.mode;
  const compareBaseRef = normalizedCompare.baseRef;
  const compareIgnoreWhitespace = normalizedCompare.ignoreWhitespace;
  const queryKey = useMemo(() => {
    const comparisonKey = checkoutDiffQueryKey(
      serverId,
      cwd,
      compareMode,
      compareBaseRef,
      compareIgnoreWhitespace,
    );
    const normalizedScope = queryScope?.trim();
    return normalizedScope ? [...comparisonKey, "scope", normalizedScope] : comparisonKey;
  }, [serverId, cwd, compareMode, compareBaseRef, compareIgnoreWhitespace, queryScope]);
  const subscriptionId = useMemo(() => `checkoutDiff:${JSON.stringify(queryKey)}`, [queryKey]);
  const routeEnabled = Boolean(queryEnabled && isConnected && cwd && !requiresUpdate);

  const query = useReplicaQuery<CheckoutDiffQueryPayload>({
    queryKey,
    enabled: routeEnabled,
    pushEvent: "checkout_diff_update",
    meta: checkoutDiffPushRoute({
      enabled: routeEnabled,
      serverId,
      subscriptionId,
      cwd,
      compare: {
        mode: compareMode,
        ...(compareBaseRef ? { baseRef: compareBaseRef } : {}),
        ignoreWhitespace: compareIgnoreWhitespace,
      },
    }),
  });

  const payload: CheckoutDiffQueryPayload | null =
    requiresUpdate && isConnected
      ? {
          requestId: "unsupported",
          cwd,
          files: [],
          error: { code: "UNKNOWN", message: "Update the host to view All changes" },
        }
      : (query.data ?? null);
  const payloadError = payload?.error ?? null;

  return {
    files: payload?.files ?? [],
    payloadError,
    diffTooLarge: payload?.diffTooLarge === true,
    isLoading: payload === null && queryEnabled && isConnected,
    isFetching: false,
    isError: Boolean(payloadError),
    error: null,
  };
}
