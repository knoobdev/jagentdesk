import { useEffect } from "react";
import { create } from "zustand";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { SkillEntry, SkillWrittenPaths } from "@jagentdesk/protocol/native-skills";
import {
  buildLegacyIdMap,
  dedupeSkillEntries,
  skillErrorMessage,
} from "@/skills/native-skill-logic";
import { useAgentSkillsStore } from "@/stores/agent-skills-store";

/**
 * Reactive cache of the active host's native skill catalog (spec 22.4,
 * ADR-0022). The daemon is the source of truth: this store hydrates from
 * `skills.catalog.list` and refetches whenever `status:skills_changed` arrives,
 * so desktop and mobile show the same list. Every mutation goes through the
 * daemon RPCs (install/uninstall/set_enabled/author/learn/fork) — nothing is
 * applied optimistically.
 *
 * The list depends on the project: `cwd` adds that project's `project`-scope
 * skills to the global ones. Catalogs are cached per cwd key ("" = global only).
 */

export type SkillCatalogStatus = "idle" | "loading" | "ready" | "error";

export interface SkillCatalogState {
  skills: SkillEntry[];
  written: SkillWrittenPaths | null;
  status: SkillCatalogStatus;
  error: string | null;
}

interface NativeSkillsState {
  serverId: string | null;
  catalogs: Record<string, SkillCatalogState>;
}

const EMPTY_CATALOG: SkillCatalogState = {
  skills: [],
  written: null,
  status: "idle",
  error: null,
};

export const useSkillsStore = create<NativeSkillsState>()(() => ({
  serverId: null,
  catalogs: {},
}));

export function catalogKey(cwd?: string | null): string {
  return cwd?.trim() ?? "";
}

// ── Daemon sync binding ──────────────────────────────────────────────────────
let boundClient: DaemonClient | null = null;
let unsubscribeStatus: (() => void) | null = null;
const inFlight = new Map<string, Promise<void>>();

function setCatalog(key: string, patch: Partial<SkillCatalogState>): void {
  useSkillsStore.setState((state) => ({
    catalogs: {
      ...state.catalogs,
      [key]: { ...(state.catalogs[key] ?? EMPTY_CATALOG), ...patch },
    },
  }));
}

/** Rewrite per-agent attachments stored with legacy JSON ids to native skillIds. */
function migrateLegacyAttachments(skills: readonly SkillEntry[]): void {
  const legacyMap = buildLegacyIdMap(skills);
  if (Object.keys(legacyMap).length > 0) {
    useAgentSkillsStore.getState().migrateLegacyIds(legacyMap);
  }
}

async function fetchCatalog(client: DaemonClient, key: string): Promise<void> {
  const current = useSkillsStore.getState().catalogs[key];
  setCatalog(key, { status: current?.status === "ready" ? "ready" : "loading" });
  try {
    const result = await client.listNativeSkills(key ? { cwd: key } : {});
    if (boundClient !== client) return;
    setCatalog(key, {
      skills: result.skills,
      written: result.written,
      status: "ready",
      error: null,
    });
    migrateLegacyAttachments(result.skills);
  } catch (error) {
    if (boundClient !== client) return;
    setCatalog(key, { status: "error", error: skillErrorMessage(error) });
  }
}

/**
 * Load (or reload with `force`) the catalog for a cwd. Concurrent calls for the
 * same key share one request.
 */
export function loadSkillCatalog(cwd?: string | null, options: { force?: boolean } = {}): void {
  const client = boundClient;
  if (!client) return;
  const key = catalogKey(cwd);
  const existing = useSkillsStore.getState().catalogs[key];
  if (!options.force && existing && existing.status !== "idle") return;
  if (inFlight.has(key)) return;
  const request = fetchCatalog(client, key).finally(() => inFlight.delete(key));
  inFlight.set(key, request);
}

/** Refetch every catalog the app has loaded (after `status:skills_changed` or a mutation). */
export function refreshSkillCatalogs(): void {
  const keys = Object.keys(useSkillsStore.getState().catalogs);
  for (const key of keys.length > 0 ? keys : [""]) {
    loadSkillCatalog(key, { force: true });
  }
}

/**
 * Point the store at a host's daemon: load the global catalog and keep every
 * loaded catalog live via `status:skills_changed`. Idempotent per client.
 */
export function bindSkillsSync(client: DaemonClient, serverId: string): void {
  if (boundClient === client && useSkillsStore.getState().serverId === serverId) {
    return;
  }
  unbindSkillsSync();
  boundClient = client;
  useSkillsStore.setState({ serverId, catalogs: {} });
  unsubscribeStatus = client.on("status", (message) => {
    const payload = message.payload as { status?: string };
    if (payload.status === "skills_changed") {
      refreshSkillCatalogs();
    }
  });
  loadSkillCatalog("");
}

export function unbindSkillsSync(): void {
  unsubscribeStatus?.();
  unsubscribeStatus = null;
  boundClient = null;
  inFlight.clear();
  useSkillsStore.setState({ serverId: null, catalogs: {} });
}

// ── Selectors / hooks ────────────────────────────────────────────────────────
export function selectSkillCatalog(cwd?: string | null) {
  const key = catalogKey(cwd);
  return (state: NativeSkillsState): SkillCatalogState => state.catalogs[key] ?? EMPTY_CATALOG;
}

/** The catalog for a cwd (global when omitted); loads it on first use. */
export function useSkillCatalog(cwd?: string | null): SkillCatalogState {
  const key = catalogKey(cwd);
  const catalog = useSkillsStore(selectSkillCatalog(key));
  const serverId = useSkillsStore((state) => state.serverId);
  useEffect(() => {
    if (serverId) loadSkillCatalog(key);
  }, [key, serverId]);
  return catalog;
}

/** Every skill across the loaded catalogs (global + projects), one entry per id. */
export function allKnownSkills(state: NativeSkillsState = useSkillsStore.getState()): SkillEntry[] {
  const keys = Object.keys(state.catalogs).sort();
  return dedupeSkillEntries(keys.map((key) => state.catalogs[key]?.skills ?? []));
}

export function findKnownSkill(skillId: string): SkillEntry | undefined {
  return allKnownSkills().find((entry) => entry.skillId === skillId);
}
