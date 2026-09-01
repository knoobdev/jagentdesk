import { create } from "zustand";

/**
 * Drives the slide-in chat dock shown alongside the database browse view. Chat
 * from a database opens the agent conversation in this right-side dock (keyed by
 * databaseId) instead of navigating to a full agent tab, so the data the user is
 * looking at stays on screen. Mirrors cluster-chat-store (minus the resource
 * "Ask AI" pending queue, which the database view doesn't have yet).
 */
interface DatabaseChatState {
  databaseId: string | null;
  agentId: string | null;
  workspaceId: string | null;
  open: boolean;
  width: number;
  /** True when the user explicitly asked for a fresh chat (blank composer). */
  draft: boolean;
  /** The project the user picked for database chats to run in (the agent cwd). */
  pickedWorkspaceId: string | null;
  openChat: (input: { databaseId: string; agentId: string; workspaceId: string | null }) => void;
  hideChat: () => void;
  showChat: () => void;
  startNewChat: () => void;
  setPickedWorkspaceId: (workspaceId: string | null) => void;
  setOpen: (open: boolean) => void;
  resetForDatabase: (databaseId: string, open?: boolean) => void;
  setWidth: (width: number) => void;
}

export const DATABASE_CHAT_MIN_WIDTH = 320;
export const DATABASE_CHAT_MAX_WIDTH = 720;
const DEFAULT_WIDTH = 420;

export const useDatabaseChatStore = create<DatabaseChatState>((set, get) => ({
  databaseId: null,
  agentId: null,
  workspaceId: null,
  open: false,
  width: DEFAULT_WIDTH,
  draft: false,
  pickedWorkspaceId: null,
  openChat: ({ databaseId, agentId, workspaceId }) =>
    set({ databaseId, agentId, workspaceId, open: true, draft: false }),
  hideChat: () => set({ open: false }),
  showChat: () => set({ open: true }),
  startNewChat: () => set({ agentId: null, workspaceId: null, open: true, draft: true }),
  setPickedWorkspaceId: (pickedWorkspaceId) => set({ pickedWorkspaceId }),
  setOpen: (open) => set({ open }),
  resetForDatabase: (databaseId, open = true) => {
    if (get().databaseId !== databaseId) {
      set({ databaseId, agentId: null, workspaceId: null, open, draft: false });
    }
  },
  setWidth: (width) =>
    set({ width: Math.max(DATABASE_CHAT_MIN_WIDTH, Math.min(DATABASE_CHAT_MAX_WIDTH, width)) }),
}));
