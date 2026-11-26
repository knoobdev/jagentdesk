import type { MemoryUsedEntry, MemoryUsedItemData } from "../shared/types";

function isEntry(value: unknown): value is MemoryUsedEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    typeof entry.text === "string" &&
    (entry.scope === "project" || entry.scope === "global") &&
    (entry.kind === "injected" || entry.kind === "searched") &&
    (typeof entry.score === "number" || entry.score === null) &&
    typeof entry.source === "object" &&
    entry.source !== null
  );
}

/** The `memory.used` timeline item's data, or null when it is not one this app understands. */
export function readMemoryUsedData(data: unknown): MemoryUsedItemData | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (typeof record.turnKey !== "string" || !Array.isArray(record.memories)) return null;
  return { turnKey: record.turnKey, memories: record.memories.filter(isEntry) };
}
