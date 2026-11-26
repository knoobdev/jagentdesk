// Memory entries (spec 41 §1). Shared by the daemon side and the app side of the built-in.

export const MEMORY_TEXT_MAX_CHARS = 1_000;
/** Default prompt budget for injected memories (spec 41 §3.1). */
export const DEFAULT_MEMORY_TOKEN_CAP = 1_500;
export const MEMORY_PLUGIN_ID = "memory";
/** Plugin timeline item kind for the per-turn "Used N memories" chip. */
export const MEMORY_USED_ITEM_KIND = "memory-used";
export const MEMORY_USED_ITEM_VERSION = 1;
/** Plugin timeline item kind for the "Remembered · …" row with Undo and Edit. */
export const MEMORY_REMEMBERED_ITEM_KIND = "memory-remembered";

/** The `memory-remembered` row's data: the memory as the tool saved it. */
export interface MemoryRememberedItemData {
  memory: Pick<MemoryRecord, "id" | "scope" | "text" | "tags" | "pinned">;
}

export type MemoryScope = "project" | "global";

/** Spec 42 §4: a lesson is a memory learned from a correction, with citations the daemon checks. */
export type MemoryKind = "memory" | "lesson";
export type MemoryStatus = "active" | "pending" | "stale" | "deprecated" | "graduated";
export const MEMORY_STATUSES: readonly MemoryStatus[] = [
  "active",
  "pending",
  "stale",
  "deprecated",
  "graduated",
];

export interface MemoryCitation {
  /** Relative to the project root (or absolute when outside it). */
  path: string;
  symbol?: string;
  /** Exact text that must still appear in the file for the lesson to be injected. */
  excerpt?: string;
}

export const MAX_CITATIONS = 5;
export const MAX_EXCERPT_CHARS = 300;
/** A lesson not rated helpful for this long goes stale (spec 42 §4). */
export const LESSON_EXPIRY_MS = 28 * 24 * 60 * 60 * 1000;
/** "Make this a project rule" bar (spec 42 §5). */
export const GRADUATION_MIN_HELPFUL = 3;
export const GRADUATION_MIN_AGENTS = 2;
export const LEARNED_RULES_HEADING = "## Learned rules";

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
  kind: MemoryKind;
  status: MemoryStatus;
  citations: MemoryCitation[];
  helpful: number;
  harmful: number;
  statusReason: string | null;
  lastValidatedAtMs: number | null;
  /** Distinct agents this entry was injected into or found by. */
  agentCount: number;
  graduatedPath: string | null;
  graduationReady: boolean;
}

/** An active lesson rated helpful at least 3 times, never harmful, used by 2+ agents. */
export function isGraduationReady(
  memory: Pick<MemoryRecord, "kind" | "status" | "helpful" | "harmful" | "agentCount">,
): boolean {
  return (
    memory.kind === "lesson" &&
    memory.status === "active" &&
    memory.helpful >= GRADUATION_MIN_HELPFUL &&
    memory.harmful === 0 &&
    memory.agentCount >= GRADUATION_MIN_AGENTS
  );
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
  /** Spec 42 §2: the "Where we are" block on the first turn after a compaction. */
  regroundAfterCompaction: boolean;
  /** Spec 42 §2: the one-line Goal · Next · Open recitation at the end of every message. */
  recitation: boolean;
  /** Spec 42 §3: ask the agent to update its ledger once the context is 80 % full. */
  ledgerNudge: boolean;
  /** Spec 42 §4: agents save lessons when the user corrects them. */
  learnFromCorrections: boolean;
  /** Spec 42 §4: lessons not rated helpful for 28 days go stale. */
  lessonExpiry: boolean;
}

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  enabled: true,
  autoInject: true,
  tokenCap: DEFAULT_MEMORY_TOKEN_CAP,
  regroundAfterCompaction: true,
  recitation: true,
  ledgerNudge: true,
  learnFromCorrections: true,
  lessonExpiry: true,
};

/** One entry of the "Used N memories" chip, frozen when the turn used it. */
export interface MemoryUsedEntry {
  id: string;
  scope: MemoryScope;
  /** Absent on rows written before spec 42. */
  memoryKind?: MemoryKind;
  text: string;
  score: number | null;
  kind: MemoryUseKind;
  source: MemorySource;
}

export interface MemoryUsedItemData {
  turnKey: string;
  memories: MemoryUsedEntry[];
}
