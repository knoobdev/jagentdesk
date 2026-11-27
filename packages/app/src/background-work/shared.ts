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

/**
 * How long a request to open the track waits for that agent's track to come on screen. Long enough
 * for the navigation that carries it (a sidebar line opening the agent's workspace); short enough
 * that a request no track took is gone before the user next visits the agent on their own.
 */
export const BACKGROUND_WORK_TRACK_OPEN_TTL_MS = 10_000;

interface TrackOpenRequest {
  key: string;
  seq: number;
  requestedAt: number;
}

interface TrackOpenRequestState {
  /** One request at a time: a newer press anywhere replaces it. */
  pending: TrackOpenRequest | null;
  seq: number;
}

/**
 * Pressing a sidebar background line, or a background row in the transcript, opens the agent's
 * background track once. The request is not a per-agent flag: a flag kept until that agent's track
 * mounted was still waiting when the press came from a view with no track (a bot chat, an archived
 * agent), and opened the panel the next time the user came back to the agent.
 */
const useTrackOpenRequests = create<TrackOpenRequestState>()(() => ({ pending: null, seq: 0 }));

function trackKey(serverId: string, agentId: string): string {
  return `${serverId}:${agentId}`;
}

export function requestBackgroundWorkTrackOpen(serverId: string, agentId: string): void {
  useTrackOpenRequests.setState((state) => {
    const seq = state.seq + 1;
    return { seq, pending: { key: trackKey(serverId, agentId), seq, requestedAt: Date.now() } };
  });
}

/**
 * Takes the pending request if it names this agent; true when it is still fresh and the track
 * should open. Only one track takes it, so a second copy of the same agent stays closed.
 */
export function takeBackgroundWorkTrackOpen(serverId: string, agentId: string): boolean {
  const { pending } = useTrackOpenRequests.getState();
  if (!pending || pending.key !== trackKey(serverId, agentId)) return false;
  useTrackOpenRequests.setState({ pending: null });
  return Date.now() - pending.requestedAt <= BACKGROUND_WORK_TRACK_OPEN_TTL_MS;
}

/** The pending request's sequence number when it names this agent, else 0. */
export function useBackgroundWorkTrackOpenRequest(serverId: string, agentId: string): number {
  const key = trackKey(serverId, agentId);
  return useTrackOpenRequests((state) => (state.pending?.key === key ? state.pending.seq : 0));
}
