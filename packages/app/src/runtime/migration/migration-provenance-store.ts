import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

// Provenance for agents that arrived on a host via a host-to-host migration.
// Keyed by the TARGET serverId, then the NEW agent id, mapping to the source
// host's human label. Used to prefix migrated agents' display names (e.g.
// "[jcode-1] Cluster chat") and to drive reverse migration when the source host
// comes back online. Persisted under `@jagentdesk:migration-provenance`.

export interface MigrationProvenanceState {
  // { [newServerId]: { [newAgentId]: sourceHostLabel } }
  byServer: Record<string, Record<string, string>>;
  // { [newServerId]: sourceServerId } — which source a host's migrated agents
  // came from, so reverse migration can target the right daemon on reconnect.
  sourceServerByTarget: Record<string, string>;
}

interface MigrationProvenanceActions {
  recordMigration: (input: {
    newServerId: string;
    sourceServerId: string;
    sourceHostLabel: string | null;
    idMap: Record<string, string>;
  }) => void;
  getSourceHostLabel: (newServerId: string, newAgentId: string) => string | null;
  getSourceServerId: (newServerId: string) => string | null;
  getMigratedAgentIds: (newServerId: string) => string[];
  clearAgents: (newServerId: string, agentIds: string[]) => void;
  clearServer: (newServerId: string) => void;
}

export type MigrationProvenanceStore = MigrationProvenanceState & MigrationProvenanceActions;

export const useMigrationProvenanceStore = create<MigrationProvenanceStore>()(
  persist(
    (set, get) => ({
      byServer: {},
      sourceServerByTarget: {},

      recordMigration: ({ newServerId, sourceServerId, sourceHostLabel, idMap }) => {
        const label = sourceHostLabel?.trim() || sourceServerId;
        set((state) => {
          const existing = state.byServer[newServerId] ?? {};
          const next = { ...existing };
          for (const newAgentId of Object.values(idMap)) {
            next[newAgentId] = label;
          }
          return {
            byServer: { ...state.byServer, [newServerId]: next },
            sourceServerByTarget: {
              ...state.sourceServerByTarget,
              [newServerId]: sourceServerId,
            },
          };
        });
      },

      getSourceHostLabel: (newServerId, newAgentId) => {
        return get().byServer[newServerId]?.[newAgentId] ?? null;
      },

      getSourceServerId: (newServerId) => {
        return get().sourceServerByTarget[newServerId] ?? null;
      },

      getMigratedAgentIds: (newServerId) => {
        return Object.keys(get().byServer[newServerId] ?? {});
      },

      clearAgents: (newServerId, agentIds) => {
        if (agentIds.length === 0) return;
        set((state) => {
          const existing = state.byServer[newServerId];
          if (!existing) return state;
          const next = { ...existing };
          for (const agentId of agentIds) {
            delete next[agentId];
          }
          const byServer = { ...state.byServer };
          const sourceServerByTarget = { ...state.sourceServerByTarget };
          if (Object.keys(next).length === 0) {
            delete byServer[newServerId];
            delete sourceServerByTarget[newServerId];
          } else {
            byServer[newServerId] = next;
          }
          return { byServer, sourceServerByTarget };
        });
      },

      clearServer: (newServerId) => {
        set((state) => {
          if (!state.byServer[newServerId] && !state.sourceServerByTarget[newServerId]) {
            return state;
          }
          const byServer = { ...state.byServer };
          const sourceServerByTarget = { ...state.sourceServerByTarget };
          delete byServer[newServerId];
          delete sourceServerByTarget[newServerId];
          return { byServer, sourceServerByTarget };
        });
      },
    }),
    {
      name: "@jagentdesk:migration-provenance",
      storage: createJSONStorage(() => AsyncStorage),
      version: 1,
      partialize: (state) => ({
        byServer: state.byServer,
        sourceServerByTarget: state.sourceServerByTarget,
      }),
    },
  ),
);

/**
 * Build a display name for an agent, prefixing it with its migration source host
 * label when the agent was imported via migration (e.g. "[jcode-1] Cluster chat").
 * Returns the unmodified name when there is no provenance.
 */
export function prefixWithMigrationSource(input: {
  serverId: string;
  agentId: string;
  name: string;
}): string {
  const label = useMigrationProvenanceStore
    .getState()
    .getSourceHostLabel(input.serverId, input.agentId);
  if (!label) {
    return input.name;
  }
  return `[${label}] ${input.name}`;
}
