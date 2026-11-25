import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ActivityGraphView } from "@jagentdesk/protocol/agent-activity-graph";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

// Activity graph panel UI state (spec 31.4): open/closed and the chosen view per agent, and the
// desktop panel width. Persisted so a reopened chat comes back the way the reader left it.

const STORAGE_KEY = "activity-graph-panel";
// Spec 31.4: 40 % of the chat width by default, never narrower than 320 px.
export const ACTIVITY_PANEL_DEFAULT_FRACTION = 0.4;
export const ACTIVITY_PANEL_MIN_WIDTH = 320;
export const ACTIVITY_PANEL_MAX_FRACTION = 0.7;
// Bounded so the persisted map does not grow with every agent ever opened.
const MAX_REMEMBERED_AGENTS = 200;

export function activityGraphAgentKey(serverId: string, agentId: string): string {
  return `${serverId}:${agentId}`;
}

interface ActivityGraphPanelState {
  openByAgent: Record<string, true>;
  viewByAgent: Record<string, ActivityGraphView>;
  widthFraction: number;
  setOpen: (key: string, open: boolean) => void;
  setView: (key: string, view: ActivityGraphView) => void;
  setWidthFraction: (fraction: number) => void;
}

function trim<T>(record: Record<string, T>): Record<string, T> {
  const keys = Object.keys(record);
  if (keys.length <= MAX_REMEMBERED_AGENTS) return record;
  const next: Record<string, T> = {};
  for (const key of keys.slice(keys.length - MAX_REMEMBERED_AGENTS)) next[key] = record[key]!;
  return next;
}

export function clampPanelFraction(fraction: number): number {
  if (!Number.isFinite(fraction)) return ACTIVITY_PANEL_DEFAULT_FRACTION;
  return Math.min(ACTIVITY_PANEL_MAX_FRACTION, Math.max(0.15, fraction));
}

export const useActivityGraphPanelStore = create<ActivityGraphPanelState>()(
  persist(
    (set) => ({
      openByAgent: {},
      viewByAgent: {},
      widthFraction: ACTIVITY_PANEL_DEFAULT_FRACTION,
      setOpen: (key, open) =>
        set((state) => {
          const next = { ...state.openByAgent };
          if (open) next[key] = true;
          else delete next[key];
          return { openByAgent: trim(next) };
        }),
      setView: (key, view) =>
        set((state) => ({ viewByAgent: trim({ ...state.viewByAgent, [key]: view }) })),
      setWidthFraction: (fraction) => set({ widthFraction: clampPanelFraction(fraction) }),
    }),
    {
      name: STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        openByAgent: state.openByAgent,
        viewByAgent: state.viewByAgent,
        widthFraction: state.widthFraction,
      }),
    },
  ),
);
