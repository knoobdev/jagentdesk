// The app's Bots settings on this device (spec 37.4.12; Orca `settings.skipNewHomeChatConfirm`,
// src/renderer/src/components/settings/bots/BotsSettingsPane.tsx:37-46): whether "New Home Chat"
// asks before it replaces the conversation a bot carries.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface BotsPreferencesState {
  askNewHomeChat: boolean;
  setAskNewHomeChat: (ask: boolean) => void;
}

export const useBotsPreferences = create<BotsPreferencesState>()(
  persist(
    (set) => ({
      askNewHomeChat: true,
      setAskNewHomeChat: (askNewHomeChat) => set({ askNewHomeChat }),
    }),
    {
      name: "jagentdesk:bots-preferences",
      version: 1,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ askNewHomeChat: state.askNewHomeChat }),
    },
  ),
);
