import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { getDesktopHost } from "@/desktop/host";

/**
 * Anti-detection ("Stealth") preference for the agentic browser. Stored per
 * device. When enabled, the desktop main process injects fingerprint/webdriver
 * patches into every new browser guest and drives human-like cursor/typing —
 * see packages/desktop stealth injection (Phase 4). The pill in the browser
 * cockpit and the settings toggle both read/write this store, so what the UI
 * shows is the real applied state, never a mock.
 */
interface BrowserStealthState {
  enabled: boolean;
  hydrated: boolean;
  setEnabled: (enabled: boolean) => void;
}

function pushToMain(enabled: boolean): void {
  // The main-process IPC may be absent on older app builds; fail soft.
  const setStealth = getDesktopHost()?.browser?.setStealthEnabled;
  if (setStealth) {
    void Promise.resolve(setStealth(enabled)).catch(() => {});
  }
}

export const useBrowserStealthStore = create<BrowserStealthState>()(
  persist(
    (set) => ({
      enabled: false,
      hydrated: false,
      setEnabled: (enabled) => {
        set({ enabled });
        pushToMain(enabled);
      },
    }),
    {
      name: "@jagentdesk:browser-stealth",
      storage: createJSONStorage(() => AsyncStorage),
      version: 1,
      onRehydrateStorage: () => (state) => {
        // Re-assert the persisted state to main on startup so injection matches
        // the toggle across app restarts.
        if (state) {
          state.hydrated = true;
          pushToMain(state.enabled);
        }
      },
    },
  ),
);
