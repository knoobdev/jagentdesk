import { useEffect } from "react";
import { create } from "zustand";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type {
  NotificationFeedChangedPayload,
  NotificationFeedListPayload,
} from "@jagentdesk/protocol/notification-feed";
import {
  applyFeedChange,
  applyFeedPage,
  EMPTY_NOTIFICATION_FEED,
  markFeedItemsReadLocally,
  type NotificationFeedState,
} from "./model";

interface NotificationFeedStore {
  feeds: Record<string, NotificationFeedState>;
  applyPage: (serverId: string, page: NotificationFeedListPayload, older: boolean) => void;
  applyChange: (serverId: string, change: NotificationFeedChangedPayload) => void;
  markReadLocally: (serverId: string, ids: readonly string[] | "all") => void;
}

/** One feed per host, filled by `useNotificationFeedSync` while the host is connected. */
export const useNotificationFeedStore = create<NotificationFeedStore>((set) => ({
  feeds: {},
  applyPage: (serverId, page, older) =>
    set((state) => ({
      feeds: {
        ...state.feeds,
        [serverId]: applyFeedPage(state.feeds[serverId] ?? EMPTY_NOTIFICATION_FEED, page, {
          older,
        }),
      },
    })),
  applyChange: (serverId, change) =>
    set((state) => ({
      feeds: {
        ...state.feeds,
        [serverId]: applyFeedChange(
          state.feeds[serverId] ?? EMPTY_NOTIFICATION_FEED,
          change,
          Date.now(),
        ),
      },
    })),
  markReadLocally: (serverId, ids) =>
    set((state) => {
      const current = state.feeds[serverId];
      if (!current) return state;
      return {
        feeds: { ...state.feeds, [serverId]: markFeedItemsReadLocally(current, ids, Date.now()) },
      };
    }),
}));

export function useNotificationFeed(serverId: string): NotificationFeedState {
  return useNotificationFeedStore((state) => state.feeds[serverId] ?? EMPTY_NOTIFICATION_FEED);
}

/**
 * Loads the first page and follows `notifications.feed.changed` for one connected host. Runs from
 * the session provider, so the badge is right even while the list is closed. A reconnect reloads
 * the first page: changes made while offline arrive with it.
 */
export function useNotificationFeedSync(input: {
  client: DaemonClient;
  serverId: string;
  supported: boolean;
  connected: boolean;
}): void {
  const { client, serverId, supported, connected } = input;
  useEffect(() => {
    if (!supported || !connected) return;
    const store = useNotificationFeedStore.getState();
    const subscription = client.observeEvents(["notifications.feed.changed"]);
    const stop = subscription.subscribe({
      snapshot: () => {},
      update: (message) => {
        if (message.type !== "notifications.feed.changed") return;
        store.applyChange(serverId, message.payload);
      },
    });
    let cancelled = false;
    void client
      .listNotificationFeed()
      .then((page) => {
        if (cancelled) return;
        store.applyPage(serverId, page, false);
        return;
      })
      .catch((error) => console.warn("[NotificationFeed] Failed to load the list", error));
    return () => {
      cancelled = true;
      stop();
      void subscription
        .release()
        .catch((error) => console.warn("[NotificationFeed] Failed to release the feed", error));
    };
  }, [client, serverId, supported, connected]);
}

/** Loads the page after the oldest row this device has. */
export async function loadOlderNotificationFeedPage(
  client: DaemonClient,
  serverId: string,
): Promise<void> {
  const feed = useNotificationFeedStore.getState().feeds[serverId];
  const oldest = feed?.items.at(-1);
  if (!feed?.hasMore || !oldest) return;
  const page = await client.listNotificationFeed({ before: oldest.id });
  useNotificationFeedStore.getState().applyPage(serverId, page, true);
}

export async function markNotificationFeedRead(
  client: DaemonClient,
  serverId: string,
  ids: readonly string[] | "all",
): Promise<void> {
  if (ids !== "all" && ids.length === 0) return;
  useNotificationFeedStore.getState().markReadLocally(serverId, ids);
  await client.markNotificationFeedRead(ids === "all" ? { all: true } : { ids: [...ids] });
}
