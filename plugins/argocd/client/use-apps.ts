import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { ArgoCdAppSummary, ArgoCdErrorCode } from "@jagentdesk/protocol/argocd/rpc-schemas";
import { applyAppsChange, sortApps, type ArgoCdAppsChange } from "./app-list";
import { errorMessage } from "./use-instances";

// Live application list of one instance (spec 30.3): `argocd.apps.subscribe` returns the
// snapshot, `argocd.apps.changed` pushes follow, `argocd.apps.unsubscribe` when the last viewer
// leaves. The daemon keeps one subscription per (session, instance), so the Applications screen
// and the sidebar share one ref-counted feed per client and instance.

export type ArgoCdAppsState =
  | { status: "loading"; pending: ArgoCdAppsChange[] }
  | { status: "error"; error: string; errorCode: ArgoCdErrorCode | null }
  | { status: "loaded"; apps: ArgoCdAppSummary[] };

type Action =
  | { type: "subscribe" }
  | { type: "snapshot"; apps: ArgoCdAppSummary[] }
  | { type: "failed"; error: string; errorCode: ArgoCdErrorCode | null }
  | { type: "changed"; change: ArgoCdAppsChange };

function reduce(state: ArgoCdAppsState, action: Action): ArgoCdAppsState {
  switch (action.type) {
    case "subscribe":
      return { status: "loading", pending: [] };
    case "snapshot":
      // Pushes that raced ahead of the snapshot response are newer than it.
      if (state.status !== "loading") return { status: "loaded", apps: sortApps(action.apps) };
      return {
        status: "loaded",
        apps: state.pending.reduce(applyAppsChange, sortApps(action.apps)),
      };
    case "failed":
      return { status: "error", error: action.error, errorCode: action.errorCode };
    case "changed":
      if (state.status === "loading") {
        return { status: "loading", pending: [...state.pending, action.change] };
      }
      if (state.status === "error") return state;
      return { status: "loaded", apps: applyAppsChange(state.apps, action.change) };
  }
}

interface Feed {
  client: DaemonClient;
  instanceId: string;
  state: ArgoCdAppsState;
  listeners: Set<() => void>;
  refs: number;
  stop: (() => void) | null;
}

const LOADING: ArgoCdAppsState = { status: "loading", pending: [] };
const feeds = new WeakMap<DaemonClient, Map<string, Feed>>();

function feedFor(client: DaemonClient, instanceId: string): Feed {
  let byInstance = feeds.get(client);
  if (!byInstance) {
    byInstance = new Map();
    feeds.set(client, byInstance);
  }
  let feed = byInstance.get(instanceId);
  if (!feed) {
    feed = { client, instanceId, state: LOADING, listeners: new Set(), refs: 0, stop: null };
    byInstance.set(instanceId, feed);
  }
  return feed;
}

function dispatch(feed: Feed, action: Action) {
  feed.state = reduce(feed.state, action);
  for (const listener of feed.listeners) listener();
}

function start(feed: Feed) {
  const { client, instanceId } = feed;
  let active = true;
  dispatch(feed, { type: "subscribe" });
  const off = client.on("argocd.apps.changed", (message) => {
    if (active && message.payload.instanceId === instanceId) {
      dispatch(feed, { type: "changed", change: message.payload });
    }
  });
  async function subscribe() {
    try {
      const res = await client.argocd("argocd.apps.subscribe.request", { instanceId });
      if (!active) return;
      if (res.error) dispatch(feed, { type: "failed", error: res.error, errorCode: res.errorCode });
      else dispatch(feed, { type: "snapshot", apps: res.apps });
    } catch (error) {
      if (!active) return;
      dispatch(feed, {
        type: "failed",
        error: errorMessage(error, "Unable to load applications"),
        errorCode: null,
      });
    }
  }
  void subscribe();
  feed.stop = () => {
    active = false;
    off();
    // Best effort: a dropped connection ends the daemon-side subscription by itself.
    client.argocd("argocd.apps.unsubscribe.request", { instanceId }).catch(() => undefined);
  };
}

function acquire(feed: Feed) {
  feed.refs += 1;
  if (feed.refs === 1) start(feed);
}

function release(feed: Feed) {
  feed.refs -= 1;
  if (feed.refs > 0) return;
  feed.stop?.();
  feed.stop = null;
}

function restart(feed: Feed) {
  feed.stop?.();
  start(feed);
}

function noopUnsubscribe() {}

export interface ArgoCdAppsHandle {
  state: ArgoCdAppsState;
  retry: () => void;
}

export function useArgoCdApps(input: {
  client: DaemonClient | null;
  instanceId: string;
  enabled: boolean;
}): ArgoCdAppsHandle {
  const { client, instanceId, enabled } = input;
  const feed = useMemo(
    () => (client && enabled && instanceId ? feedFor(client, instanceId) : null),
    [client, enabled, instanceId],
  );

  useEffect(() => {
    if (!feed) return;
    acquire(feed);
    return () => release(feed);
  }, [feed]);

  const subscribe = useCallback(
    (listener: () => void) => {
      if (!feed) return noopUnsubscribe;
      feed.listeners.add(listener);
      return () => {
        feed.listeners.delete(listener);
      };
    },
    [feed],
  );
  const getSnapshot = useCallback(() => feed?.state ?? LOADING, [feed]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const retry = useCallback(() => {
    if (feed) restart(feed);
  }, [feed]);
  return { state, retry };
}
