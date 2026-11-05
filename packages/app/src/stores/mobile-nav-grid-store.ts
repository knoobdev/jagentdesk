import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface MobileNavGridStoreState {
  /** The drawer's "Menu" grid is expanded by default; the collapse choice survives restarts. */
  collapsed: boolean;
  toggleCollapsed: () => void;
}

export const useMobileNavGridStore = create<MobileNavGridStoreState>()(
  persist(
    (set) => ({
      collapsed: false,
      toggleCollapsed: () => set((state) => ({ collapsed: !state.collapsed })),
    }),
    {
      name: "mobile-nav-grid",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ collapsed: state.collapsed }),
    },
  ),
);
