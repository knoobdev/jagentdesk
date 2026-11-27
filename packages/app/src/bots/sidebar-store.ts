// The Bots sidebar section's client state (spec 37.4.1): folded or not, the dragged height of the
// split with Projects, and which bots and chats are unfolded. Saved per client, like the Tools fold.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** `shared/sidebar-bots-height.ts`: the Bots list never below 88 px; Projects keeps at least 120 px. */
export const SIDEBAR_BOTS_MIN_HEIGHT = 88;
export const SIDEBAR_PROJECTS_MIN_HEIGHT = 120;
/** Unsized, the section grows with its rows up to 40 % of the sidebar's middle. */
export const SIDEBAR_BOTS_MAX_SHARE = 0.4;

export function clampBotsHeight(height: number, middle: number): number {
  const max = Math.max(SIDEBAR_BOTS_MIN_HEIGHT, middle - SIDEBAR_PROJECTS_MIN_HEIGHT);
  return Math.min(max, Math.max(SIDEBAR_BOTS_MIN_HEIGHT, height));
}

interface BotsSidebarState {
  collapsed: boolean;
  /** The dragged height in px; null: fit the rows, capped at 40 %. */
  height: number | null;
  /** `<serverId>:<botId>` → unfolded. Bots start folded. */
  unfolded: Record<string, boolean>;
  /** `<serverId>:<botId>:<chatId>` → "open" | "folded"; without one a chat opens while it has live workers. */
  chatFolds: Record<string, "open" | "folded">;
  toggleCollapsed: () => void;
  setHeight: (height: number | null) => void;
  setUnfolded: (key: string, unfolded: boolean) => void;
  setChatFold: (key: string, fold: "open" | "folded") => void;
}

export const useBotsSidebarStore = create<BotsSidebarState>()(
  persist(
    (set) => ({
      collapsed: false,
      height: null,
      unfolded: {},
      chatFolds: {},
      toggleCollapsed: () => set((state) => ({ collapsed: !state.collapsed })),
      setHeight: (height) => set({ height }),
      setUnfolded: (key, unfolded) =>
        set((state) => ({ unfolded: { ...state.unfolded, [key]: unfolded } })),
      setChatFold: (key, fold) =>
        set((state) => ({ chatFolds: { ...state.chatFolds, [key]: fold } })),
    }),
    {
      name: "jagentdesk:bots-sidebar",
      version: 1,
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);

/** The sidebar middle's measured height, for the 40 % cap and the drag clamp. */
export const useSidebarMiddleHeight = create<{ height: number; set: (height: number) => void }>()(
  (set) => ({ height: 0, set: (height) => set({ height }) }),
);
