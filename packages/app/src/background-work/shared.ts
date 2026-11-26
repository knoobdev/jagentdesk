import { useCallback, useSyncExternalStore } from "react";
import { create } from "zustand";
import { createHostBackgroundWorkModel } from "./host";

export type BackgroundWorkModel = ReturnType<typeof createHostBackgroundWorkModel>;

// One model per agent, shared by the composer track and every sidebar line that shows the same
// agent. A model only observes the host while something is subscribed, so keeping idle ones in
// the map costs a closure, not a subscription.
const models = new Map<string, BackgroundWorkModel>();

export function getBackgroundWorkModel(serverId: string, agentId: string): BackgroundWorkModel {
  const key = `${serverId}:${agentId}`;
  const existing = models.get(key);
  if (existing) return existing;
  const model = createHostBackgroundWorkModel(serverId, agentId);
  models.set(key, model);
  return model;
}

const IDLE_SNAPSHOT: ReturnType<BackgroundWorkModel["getSnapshot"]> = {
  status: "loading",
  items: null,
};

function noopUnsubscribe() {}

/**
 * The agent's live background work, or `null` while unknown. `enabled` lets a list row skip the
 * host subscription entirely when the directory summary says the agent has no background work.
 */
export function useBackgroundWorkSnapshot(
  serverId: string,
  agentId: string,
  enabled: boolean,
): ReturnType<BackgroundWorkModel["getSnapshot"]> {
  const model = enabled ? getBackgroundWorkModel(serverId, agentId) : null;
  const subscribe = useCallback(
    (listener: () => void) => (model ? model.subscribe(listener) : noopUnsubscribe),
    [model],
  );
  const getSnapshot = useCallback(() => (model ? model.getSnapshot() : IDLE_SNAPSHOT), [model]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

interface TrackOpenRequestState {
  requests: Record<string, number>;
  request: (serverId: string, agentId: string) => void;
  consume: (serverId: string, agentId: string) => void;
}

/** Pressing a sidebar background line opens the agent with its background track already open. */
export const useBackgroundWorkTrackOpenRequests = create<TrackOpenRequestState>()((set) => ({
  requests: {},
  request: (serverId, agentId) =>
    set((state) => ({
      requests: {
        ...state.requests,
        [`${serverId}:${agentId}`]: (state.requests[`${serverId}:${agentId}`] ?? 0) + 1,
      },
    })),
  consume: (serverId, agentId) =>
    set((state) => {
      const key = `${serverId}:${agentId}`;
      if (!(key in state.requests)) return state;
      const requests = { ...state.requests };
      delete requests[key];
      return { requests };
    }),
}));

export function requestBackgroundWorkTrackOpen(serverId: string, agentId: string): void {
  useBackgroundWorkTrackOpenRequests.getState().request(serverId, agentId);
}

export function consumeBackgroundWorkTrackOpen(serverId: string, agentId: string): void {
  useBackgroundWorkTrackOpenRequests.getState().consume(serverId, agentId);
}

export function useBackgroundWorkTrackOpenRequest(serverId: string, agentId: string): number {
  return useBackgroundWorkTrackOpenRequests(
    (state) => state.requests[`${serverId}:${agentId}`] ?? 0,
  );
}
