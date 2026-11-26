import { create } from "zustand";

interface ConnectionLogSheetState {
  visible: boolean;
  open: () => void;
  close: () => void;
}

export const useConnectionLogSheetStore = create<ConnectionLogSheetState>((set) => ({
  visible: false,
  open: () => set({ visible: true }),
  close: () => set({ visible: false }),
}));
