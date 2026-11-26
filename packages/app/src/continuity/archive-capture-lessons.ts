import { create } from "zustand";
import { selectHostFeature } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";

/** Spec 42 §7: archiving an agent with at least this many turns offers Capture lessons first. */
export const CAPTURE_LESSONS_ON_ARCHIVE_MIN_TURNS = 20;

export type ArchiveChoice = "archive" | "capture" | "cancel";

interface ArchivePromptState {
  prompt: {
    serverId: string;
    agentId: string;
    turns: number;
    resolve: (choice: ArchiveChoice) => void;
  } | null;
  settle: (choice: ArchiveChoice) => void;
}

export const useArchivePromptStore = create<ArchivePromptState>((set, get) => ({
  prompt: null,
  settle: (choice) => {
    get().prompt?.resolve(choice);
    set({ prompt: null });
  },
}));

/**
 * Spec 42 §7: before archiving an agent with 20+ turns on a host that supports it, ask whether to
 * capture lessons first. Resolves "archive" right away for every other agent.
 */
export function askCaptureLessonsBeforeArchive(input: {
  serverId: string;
  agentId: string;
}): Promise<ArchiveChoice> {
  const state = useSessionStore.getState();
  const agent = state.sessions[input.serverId]?.agents.get(input.agentId);
  const turns = agent?.usageTotals?.turns ?? 0;
  if (
    turns < CAPTURE_LESSONS_ON_ARCHIVE_MIN_TURNS ||
    !selectHostFeature(state, input.serverId, "durableContext") ||
    agent?.status === "running"
  ) {
    return Promise.resolve("archive");
  }
  return new Promise((resolve) => {
    useArchivePromptStore.getState().prompt?.resolve("cancel");
    useArchivePromptStore.setState({ prompt: { ...input, turns, resolve } });
  });
}
