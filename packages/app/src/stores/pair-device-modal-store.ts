import { create } from "zustand";

interface PairDeviceModalState {
  serverId: string | null;
  open: (serverId: string) => void;
  close: () => void;
}

export const usePairDeviceModalStore = create<PairDeviceModalState>((set) => ({
  serverId: null,
  open: (serverId) => set({ serverId }),
  close: () => set({ serverId: null }),
}));
