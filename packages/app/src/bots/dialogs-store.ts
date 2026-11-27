// The bots dialogs open anywhere in the app (sidebar + menu, the empty card, Settings, a workspace's
// context menu) and render once, from `BotsDialogsHost`. One open at a time, as Orca's.
import { create } from "zustand";

export type BotsDialog =
  /** `NewBotDialog` (spec 37.5): blank, from a template, or from Hand to bot. */
  | {
      kind: "newBot";
      serverId: string;
      templateId?: string;
      /** "Blank bot for “query”": the Identity it opens with. */
      identity?: string;
      handOver?: { workspaceId: string; name: string; goal?: string };
    }
  /** `BotTemplatesDialog` (spec 37.4.10). `query` seeds the search. */
  | { kind: "templates"; serverId: string; query?: string }
  /** `HandToBotFlow` (spec 37.4.11). */
  | { kind: "handToBot"; serverId: string; workspaceId: string; name: string }
  /** "From a link…" (spec 37.13.3): `sharing/receive-flow.tsx`. */
  | { kind: "shareLink"; serverId: string }
  /** The group members dialog (spec 37.3.6). */
  | { kind: "group"; serverId: string; roomId?: string };

interface BotsDialogsStore {
  dialog: BotsDialog | null;
  open: (dialog: BotsDialog) => void;
  close: () => void;
}

export const useBotsDialogs = create<BotsDialogsStore>()((set) => ({
  dialog: null,
  open: (dialog) => set({ dialog }),
  close: () => set({ dialog: null }),
}));

export function openBotsDialog(dialog: BotsDialog): void {
  useBotsDialogs.getState().open(dialog);
}
