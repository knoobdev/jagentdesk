import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ActivityGraphGetResponsePayload,
  ActivityGraphNodeStatusEntry,
  ActivityGraphView,
} from "@jagentdesk/protocol/agent-activity-graph";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";

// Loads and follows one agent's activity graph (spec 31.3/31.5):
//   - the live (latest) turn is subscribed: `changed` refetches the HTML, `status` is handed to the
//     frame through `onStatus` without touching the document (no reload, no lost pan/zoom);
//   - an older turn is a one-off render (turnIndex) and is not followed.

export type ActivityGraphGraph = Omit<ActivityGraphGetResponsePayload, "requestId" | "error">;

export type ActivityGraphLoadState =
  | { kind: "loading" }
  | { kind: "ready"; graph: ActivityGraphGraph }
  | { kind: "empty" }
  | { kind: "failed" }
  | { kind: "offline" };

export interface UseActivityGraphInput {
  client: DaemonClient | null;
  agentId: string;
  view: ActivityGraphView;
  // null = the live (latest) turn.
  turnIndex: number | null;
  enabled: boolean;
  onStatus: (nodes: ActivityGraphNodeStatusEntry[]) => void;
}

export function useActivityGraph({
  client,
  agentId,
  view,
  turnIndex,
  enabled,
  onStatus,
}: UseActivityGraphInput): { state: ActivityGraphLoadState; retry: () => void } {
  const [state, setState] = useState<ActivityGraphLoadState>(
    client ? { kind: "loading" } : { kind: "offline" },
  );
  const [attempt, setAttempt] = useState(0);
  const versionRef = useRef<number | null>(null);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  useEffect(() => {
    if (!enabled) return undefined;
    if (!client) {
      setState({ kind: "offline" });
      return undefined;
    }
    let alive = true;
    let subscriptionId: string | null = null;
    let inFlight: Promise<void> | null = null;
    let refetchQueued = false;
    const live = turnIndex === null;
    versionRef.current = null;
    setState({ kind: "loading" });

    const fetchGraph = async () => {
      try {
        const payload = await client.activityGraphGet({
          agentId,
          view,
          ...(turnIndex !== null ? { turnIndex } : {}),
        });
        if (!alive) return;
        if (payload.error === "no_activity") {
          versionRef.current = null;
          setState({ kind: "empty" });
          return;
        }
        if (payload.error) {
          setState({ kind: "failed" });
          return;
        }
        if (versionRef.current === payload.graphVersion) {
          // Same document: only statuses may have moved.
          onStatusRef.current(payload.nodes);
          return;
        }
        versionRef.current = payload.graphVersion;
        const { requestId: _requestId, error: _error, ...graph } = payload;
        setState({ kind: "ready", graph });
      } catch {
        if (alive) setState({ kind: "failed" });
      }
    };
    const refetch = () => {
      if (inFlight) {
        refetchQueued = true;
        return;
      }
      inFlight = fetchGraph().finally(() => {
        inFlight = null;
        if (refetchQueued && alive) {
          refetchQueued = false;
          refetch();
        }
      });
    };

    const offChanged = live
      ? client.onActivityGraphChanged((payload) => {
          if (payload.agentId !== agentId || payload.view !== view) return;
          if (versionRef.current !== null && payload.graphVersion <= versionRef.current) return;
          refetch();
        })
      : () => undefined;
    const offStatus = live
      ? client.onActivityGraphStatus((payload) => {
          if (payload.agentId !== agentId || payload.view !== view) return;
          if (payload.graphVersion !== versionRef.current) return;
          onStatusRef.current(payload.nodes);
        })
      : () => undefined;

    void (async () => {
      if (live) {
        try {
          subscriptionId = await client.activityGraphSubscribe({ agentId, view });
        } catch {
          subscriptionId = null;
        }
        if (!alive) {
          if (subscriptionId) void client.activityGraphUnsubscribe(subscriptionId).catch(() => {});
          return;
        }
      }
      refetch();
    })();

    return () => {
      alive = false;
      offChanged();
      offStatus();
      if (subscriptionId) void client.activityGraphUnsubscribe(subscriptionId).catch(() => {});
    };
  }, [client, agentId, view, turnIndex, enabled, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { state, retry };
}
