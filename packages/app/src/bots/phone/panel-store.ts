// The phone's bot panel (spec 37.6, Orca dfdb4fda (MIT) mobile/src/bots/MobileBotPanel.tsx:1-4): a
// full-screen sheet over the Home Chat, tabs Items · Chats · Files, Items first. Which bot it is open for
// and its tab are phone state; what a page shows (an item, Settings and its pages, Connectors) is the
// panel's own state in `../panel-store.ts`, so a Home Chat item chip, a Settings link or a sidebar
// "Bot settings…" opens the same page on a phone as on the desktop.
import { create } from "zustand";
import { useBotPanelStore } from "@/bots/panel-store";

export type PhoneBotPanelTab = "items" | "chats" | "files";

interface PhoneBotPanelState {
  /** The bot whose panel is showing; null while closed. */
  openBotId: string | null;
  tab: PhoneBotPanelTab;
  open: (botId: string, tab?: PhoneBotPanelTab) => void;
  close: () => void;
  setTab: (tab: PhoneBotPanelTab) => void;
}

export const usePhoneBotPanel = create<PhoneBotPanelState>()((set) => ({
  openBotId: null,
  tab: "items",
  // Each open lands on Items unless asked otherwise (`MobileBotPanel.tsx:129-139`).
  open: (botId, tab = "items") => set({ openBotId: botId, tab }),
  close: () => set({ openBotId: null }),
  setTab: (tab) => set({ tab }),
}));

/** Closes the panel and leaves its page, so the next open starts on the tabs. */
export function closePhoneBotPanel(botId: string): void {
  usePhoneBotPanel.getState().close();
  const panel = useBotPanelStore.getState();
  panel.backToActivity(botId);
  if (panel.byBot[botId]?.tab === "connectors") panel.setTab(botId, "home");
}
