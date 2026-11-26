import { randomUUID } from "node:crypto";
import type { JsonValue } from "@jagentdesk/protocol/agent-types";
import type { Logger } from "pino";
import type {
  AgentManager,
  BuiltinProject,
  BuiltinProjectAccess,
  MemoryTurnInjection,
  SessionOutboundMessage,
} from "../../../packages/server/src/server/plugins/builtin/host-api.js";
import {
  DEFAULT_MEMORY_SETTINGS,
  MEMORY_PLUGIN_ID,
  MEMORY_REMEMBERED_ITEM_KIND,
  MEMORY_USED_ITEM_KIND,
  MEMORY_USED_ITEM_VERSION,
  type MemoryRecord,
  type MemoryScope,
  type MemorySettings,
  type MemoryUsedEntry,
  type MemoryUseKind,
  type ScoredMemory,
} from "../shared/types.js";
import { MemoryInputError, MemoryStore } from "./store.js";

const MIN_TOKEN_CAP = 100;
const MAX_TOKEN_CAP = 8_000;

export interface MemoryServiceDeps {
  store: MemoryStore;
  agentManager: Pick<AgentManager, "getAgent" | "appendTimelineItem">;
  projects?: BuiltinProjectAccess;
  broadcast(message: SessionOutboundMessage): void;
  logger: Logger;
  /** False while the built-in is turned off; the port then injects nothing. */
  isEnabled(): boolean;
}

interface TurnCard {
  turnKey: string;
  entries: MemoryUsedEntry[];
}

/** Daemon-wide Memory state: the store, settings, and the per-turn "Used N memories" cards. */
export class MemoryService {
  private readonly turnCards = new Map<string, TurnCard>();

  constructor(private readonly deps: MemoryServiceDeps) {}

  get store(): MemoryStore {
    return this.deps.store;
  }

  settings(): MemorySettings {
    const raw = this.deps.store.getSetting("settings");
    if (!raw) return { ...DEFAULT_MEMORY_SETTINGS };
    return { ...DEFAULT_MEMORY_SETTINGS, ...(JSON.parse(raw) as Partial<MemorySettings>) };
  }

  updateSettings(patch: Partial<MemorySettings>): MemorySettings {
    const next = { ...this.settings() };
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.autoInject !== undefined) next.autoInject = patch.autoInject;
    if (patch.tokenCap !== undefined)
      next.tokenCap = Math.max(MIN_TOKEN_CAP, Math.min(MAX_TOKEN_CAP, Math.round(patch.tokenCap)));
    this.deps.store.setSetting("settings", JSON.stringify(next));
    this.changed(null);
    return next;
  }

  async listProjects(): Promise<BuiltinProject[]> {
    return (await this.deps.projects?.list()) ?? [];
  }

  async projectIdForAgent(agentId: string | null | undefined): Promise<string | null> {
    if (!agentId || !this.deps.projects) return null;
    return (await this.deps.projects.forAgent(agentId))?.projectId ?? null;
  }

  /** The `remember` tool. */
  async remember(input: {
    agentId: string | null;
    text: string;
    scope: MemoryScope;
    tags?: readonly string[];
  }): Promise<{ memory: MemoryRecord; deduplicated: boolean }> {
    this.requireEnabled();
    const projectId =
      input.scope === "project" ? await this.projectIdForAgent(input.agentId) : null;
    const provider = input.agentId
      ? this.deps.agentManager.getAgent(input.agentId)?.provider
      : null;
    const result = this.deps.store.add({
      scope: input.scope,
      projectId,
      text: input.text,
      tags: input.tags,
      source: {
        by: "agent",
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(provider ? { provider } : {}),
      },
    });
    this.changed(result.memory);
    if (input.agentId) await this.showRemembered(input.agentId, result.memory);
    return result;
  }

  /**
   * "Remembered · …" (spec 41 §2) as its own timeline row: a folded turn hides its tool calls,
   * but daemon plugin rows stay visible.
   */
  private async showRemembered(agentId: string, memory: MemoryRecord): Promise<void> {
    try {
      await this.deps.agentManager.appendTimelineItem(agentId, {
        type: "plugin",
        id: `memory-remembered:${memory.id}`,
        pluginId: MEMORY_PLUGIN_ID,
        kind: MEMORY_REMEMBERED_ITEM_KIND,
        version: 1,
        data: {
          memory: {
            id: memory.id,
            scope: memory.scope,
            text: memory.text,
            tags: [...memory.tags],
            pinned: memory.pinned,
          },
        },
      });
    } catch (error) {
      this.deps.logger.warn({ err: error, agentId }, "Could not show the remembered memory");
    }
  }

  /** The `search_memory` tool; the results join this turn's "Used N memories" card. */
  async search(input: {
    agentId: string | null;
    query: string;
    scope?: MemoryScope;
    limit?: number;
  }): Promise<ScoredMemory[]> {
    this.requireEnabled();
    const projectId = await this.projectIdForAgent(input.agentId);
    if (input.scope === "project" && !projectId) return [];
    const results = this.deps.store.search({
      query: input.query,
      projectId,
      scope: input.scope,
      limit: input.limit,
    });
    if (input.agentId && results.length > 0)
      await this.recordTurnUse(
        input.agentId,
        this.currentTurnKey(input.agentId),
        "searched",
        results,
      );
    return results;
  }

  /** The `list_memories` tool. */
  async listForAgent(input: {
    agentId: string | null;
    scope?: MemoryScope;
    tag?: string;
  }): Promise<MemoryRecord[]> {
    this.requireEnabled();
    const projectId = await this.projectIdForAgent(input.agentId);
    if (input.scope === "project" && !projectId) return [];
    return this.deps.store.list({ scope: input.scope, projectId, tag: input.tag });
  }

  /** The Memory port: auto-inject (spec 41 §3.1). Never calls a model. */
  async prepareUserTurn(input: {
    agentId: string;
    text: string;
  }): Promise<MemoryTurnInjection | null> {
    if (!this.deps.isEnabled()) return null;
    const settings = this.settings();
    if (!settings.enabled || !settings.autoInject) return null;
    const projectId = await this.projectIdForAgent(input.agentId);
    const memories = this.deps.store.selectForPrompt({
      text: input.text,
      projectId,
      tokenCap: settings.tokenCap,
    });
    if (memories.length === 0) return null;
    return {
      block: {
        type: "text",
        mimeType: "text/plain",
        title: "Relevant memories",
        text: renderMemoryBlock(memories),
      },
      memoryIds: memories.map((memory) => memory.id),
      commit: async ({ messageId }) => {
        const turnKey = this.currentTurnKey(input.agentId, messageId ?? undefined);
        await this.recordTurnUse(input.agentId, turnKey, "injected", memories);
      },
    };
  }

  /** Memory page and "Remember this": create or edit a memory as the user. */
  async saveAsUser(input: {
    id?: string;
    scope?: MemoryScope;
    projectId?: string;
    agentId?: string;
    timelineSeq?: number;
    text?: string;
    tags?: readonly string[];
    pinned?: boolean;
  }): Promise<{ memory: MemoryRecord; deduplicated: boolean }> {
    if (input.id) {
      const memory = this.deps.store.update(input.id, {
        text: input.text,
        tags: input.tags,
        pinned: input.pinned,
      });
      this.changed(memory);
      return { memory, deduplicated: false };
    }
    if (input.text === undefined) throw new MemoryInputError("Memory text is empty.", "empty");
    const scope = input.scope ?? "project";
    const projectId =
      scope === "project"
        ? (input.projectId ?? (await this.projectIdForAgent(input.agentId)))
        : null;
    const provider = input.agentId
      ? this.deps.agentManager.getAgent(input.agentId)?.provider
      : null;
    const result = this.deps.store.add({
      scope,
      projectId,
      text: input.text,
      tags: input.tags,
      pinned: input.pinned,
      source: {
        by: "user",
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(provider ? { provider } : {}),
        ...(input.timelineSeq !== undefined ? { timelineSeq: input.timelineSeq } : {}),
      },
    });
    this.changed(result.memory);
    return result;
  }

  remove(id: string): boolean {
    const memory = this.deps.store.get(id);
    const deleted = this.deps.store.remove(id);
    if (deleted && memory) this.changed(memory);
    return deleted;
  }

  private requireEnabled(): void {
    if (!this.settings().enabled)
      throw new MemoryInputError("Memory is turned off in Settings → Memory.", "disabled");
  }

  private currentTurnKey(agentId: string, fallback?: string): string {
    const agent = this.deps.agentManager.getAgent(agentId);
    return agent?.activeForegroundTurnId ?? fallback ?? `turn-${randomUUID()}`;
  }

  private async recordTurnUse(
    agentId: string,
    turnKey: string,
    kind: MemoryUseKind,
    memories: readonly ScoredMemory[],
  ): Promise<void> {
    this.deps.store.recordUses({ agentId, turnKey, kind, memories });
    const cardKey = `${agentId}:${turnKey}`;
    const card = this.turnCards.get(cardKey) ?? { turnKey, entries: [] };
    for (const memory of memories) {
      if (card.entries.some((entry) => entry.id === memory.id)) continue;
      card.entries.push({
        id: memory.id,
        scope: memory.scope,
        text: memory.text,
        score: memory.score,
        kind,
        source: memory.source,
      });
    }
    // One card per turn; later searches in the turn update it in place (same item id).
    this.turnCards.delete(cardKey);
    this.turnCards.set(cardKey, card);
    if (this.turnCards.size > 200) this.turnCards.delete(this.turnCards.keys().next().value!);
    try {
      await this.deps.agentManager.appendTimelineItem(agentId, {
        type: "plugin",
        id: `memory-used:${turnKey}`,
        pluginId: MEMORY_PLUGIN_ID,
        kind: MEMORY_USED_ITEM_KIND,
        version: MEMORY_USED_ITEM_VERSION,
        data: {
          turnKey,
          memories: card.entries.map(usedEntryJson),
        },
      });
    } catch (error) {
      this.deps.logger.warn({ err: error, agentId }, "Could not show the memories a turn used");
    }
    this.changed(null);
  }

  private changed(memory: MemoryRecord | null): void {
    this.deps.broadcast({
      type: "memory.changed",
      payload: {
        memoryId: memory?.id ?? null,
        scope: memory?.scope ?? null,
        projectId: memory?.projectId ?? null,
      },
    });
  }
}

/** The timeline item's JSON for one entry; a copy, so later card updates never mutate it. */
function usedEntryJson(entry: MemoryUsedEntry): JsonValue {
  const source: { [key: string]: JsonValue } = { by: entry.source.by };
  if (entry.source.agentId !== undefined) source.agentId = entry.source.agentId;
  if (entry.source.provider !== undefined) source.provider = entry.source.provider;
  if (entry.source.timelineSeq !== undefined) source.timelineSeq = entry.source.timelineSeq;
  return {
    id: entry.id,
    scope: entry.scope,
    text: entry.text,
    score: entry.score,
    kind: entry.kind,
    source,
  };
}

/** The block the provider receives in front of the user's message. */
export function renderMemoryBlock(memories: readonly ScoredMemory[]): string {
  const lines = memories.map((memory) => {
    const labels = [memory.scope, ...(memory.pinned ? ["pinned"] : [])].join(", ");
    return `- [${labels}] ${memory.text.replace(/\s*\n\s*/g, " ")}`;
  });
  return [
    "<relevant-memories>",
    "Notes saved in JAgentDesk Memory by earlier agents or by the user. Apply the ones that fit this message; they can be out of date. Use search_memory to look for more.",
    ...lines,
    "</relevant-memories>",
  ].join("\n");
}
