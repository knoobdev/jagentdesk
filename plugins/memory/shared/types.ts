// Memory entries (spec 41 §1). Shared by the daemon side and the app side of the built-in.

export const MEMORY_TEXT_MAX_CHARS = 1_000;
/** Default prompt budget for injected memories (spec 41 §3.1). */
export const DEFAULT_MEMORY_TOKEN_CAP = 1_500;
export const MEMORY_PLUGIN_ID = "memory";
/** Plugin timeline item kind for the per-turn "Used N memories" chip. */
export const MEMORY_USED_ITEM_KIND = "memory-used";
export const MEMORY_USED_ITEM_VERSION = 1;

export type MemoryScope = "project" | "global";

export interface MemorySource {
  agentId?: string;
  provider?: string;
  timelineSeq?: number;
  by: "agent" | "user";
}

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  projectId: string | null;
  text: string;
  tags: string[];
  pinned: boolean;
  source: MemorySource;
  createdAtMs: number;
  updatedAtMs: number;
  lastUsedAtMs: number | null;
  useCount: number;
}

/** `score` is the relevance score; null for a pinned memory injected without a match. */
export interface ScoredMemory extends MemoryRecord {
  score: number | null;
}

export type MemoryUseKind = "injected" | "searched";

export interface MemoryUse {
  memory: MemoryRecord;
  turnKey: string;
  kind: MemoryUseKind;
  score: number | null;
  usedAtMs: number;
}

export interface MemorySettings {
  enabled: boolean;
  autoInject: boolean;
  tokenCap: number;
}

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  enabled: true,
  autoInject: true,
  tokenCap: DEFAULT_MEMORY_TOKEN_CAP,
};

/** One entry of the "Used N memories" chip, frozen when the turn used it. */
export interface MemoryUsedEntry {
  id: string;
  scope: MemoryScope;
  text: string;
  score: number | null;
  kind: MemoryUseKind;
  source: MemorySource;
}

export interface MemoryUsedItemData {
  turnKey: string;
  memories: MemoryUsedEntry[];
}
