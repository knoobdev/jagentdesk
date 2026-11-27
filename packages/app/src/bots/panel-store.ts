// Where each bot page is: the right panel's tab (Home · Connectors · Chats · Files, spec 37.4.3),
// what the Home tab shows (Activity, an item, or Settings, spec 37.4.4-37.4.8), its item filters,
// and the file the Files tab opened in the centre. Client state, per bot, not persisted.
import { create } from "zustand";

export type BotPanelTab = "home" | "connectors" | "chats" | "files";
/** Settings pages (`bots/settings-view/*`): the root list and the pages a row pushes. */
export type BotSettingsPage =
  | "root"
  | "lookAround"
  | "tidyUp"
  | "soul"
  | "memory"
  | "whoCanAsk"
  | "skills"
  | "share";
export type BotPanelView =
  | { kind: "activity" }
  | { kind: "item"; itemId: string }
  | { kind: "settings"; page: BotSettingsPage };
export interface BotItemFilters {
  needsYouOnly: boolean;
  /** `item.chat.id` of the chat the owner filtered by. */
  chatId: string | null;
}
export interface BotPanelState {
  tab: BotPanelTab;
  view: BotPanelView;
  filters: BotItemFilters;
  /** A home file the Files tab opened in the centre, beside Home Chat. */
  openFile: string | null;
}

const DEFAULT_PANEL: BotPanelState = {
  tab: "home",
  view: { kind: "activity" },
  filters: { needsYouOnly: false, chatId: null },
  openFile: null,
};

interface BotPanelStore {
  byBot: Record<string, BotPanelState>;
  /** Desktop: the inspector is showing. */
  inspectorOpen: boolean;
  setInspectorOpen: (open: boolean) => void;
  setTab: (botId: string, tab: BotPanelTab) => void;
  openItem: (botId: string, itemId: string) => void;
  openSettings: (botId: string, page?: BotSettingsPage) => void;
  backToActivity: (botId: string) => void;
  setFilters: (botId: string, filters: Partial<BotItemFilters>) => void;
  setOpenFile: (botId: string, path: string | null) => void;
}

function update(
  byBot: Record<string, BotPanelState>,
  botId: string,
  patch: (state: BotPanelState) => Partial<BotPanelState>,
): Record<string, BotPanelState> {
  const current = byBot[botId] ?? DEFAULT_PANEL;
  return { ...byBot, [botId]: { ...current, ...patch(current) } };
}

export const useBotPanelStore = create<BotPanelStore>()((set) => ({
  byBot: {},
  inspectorOpen: true,
  setInspectorOpen: (inspectorOpen) => set({ inspectorOpen }),
  setTab: (botId, tab) => set((s) => ({ byBot: update(s.byBot, botId, () => ({ tab })) })),
  openItem: (botId, itemId) =>
    set((s) => ({
      inspectorOpen: true,
      byBot: update(s.byBot, botId, () => ({ tab: "home", view: { kind: "item", itemId } })),
    })),
  openSettings: (botId, page = "root") =>
    set((s) => ({
      inspectorOpen: true,
      byBot: update(s.byBot, botId, () => ({ tab: "home", view: { kind: "settings", page } })),
    })),
  backToActivity: (botId) =>
    set((s) => ({ byBot: update(s.byBot, botId, () => ({ view: { kind: "activity" } })) })),
  setFilters: (botId, filters) =>
    set((s) => ({
      byBot: update(s.byBot, botId, (state) => ({ filters: { ...state.filters, ...filters } })),
    })),
  setOpenFile: (botId, openFile) =>
    set((s) => ({ byBot: update(s.byBot, botId, () => ({ openFile })) })),
}));

export function useBotPanel(botId: string): BotPanelState {
  return useBotPanelStore((s) => s.byBot[botId] ?? DEFAULT_PANEL);
}
