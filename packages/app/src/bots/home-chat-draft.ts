// The Home Chat composer's draft, written from outside it: "New automation" pre-fills
// "Set up an automation that " (spec 37.4.4 item 4) and focuses the composer without sending.
import { create } from "zustand";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";

/** The composer's synthetic agent id (`MessageComposer` draftId `bot:<id>`). */
export function homeChatComposerId(botId: string): string {
  return `bots-bot:${botId}`;
}

export function homeChatDraftKey(serverId: string, botId: string): string {
  return buildDraftStoreKey({ serverId, agentId: homeChatComposerId(botId) });
}

interface HomeChatFocusState {
  /** Bumped per request; the Home Chat composer focuses when its bot's count changes. */
  requests: Record<string, number>;
  request: (botId: string) => void;
}

export const useHomeChatFocus = create<HomeChatFocusState>()((set) => ({
  requests: {},
  request: (botId) =>
    set((state) => ({
      requests: { ...state.requests, [botId]: (state.requests[botId] ?? 0) + 1 },
    })),
}));

export function prefillHomeChat(serverId: string, botId: string, text: string): void {
  useDraftStore.getState().replaceDraftText({ draftKey: homeChatDraftKey(serverId, botId), text });
  useHomeChatFocus.getState().request(botId);
}
