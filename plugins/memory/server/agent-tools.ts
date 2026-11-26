import { z } from "zod";
import type {
  BuiltinToolContext,
  JAgentDeskToolResult,
  RegisterBuiltinTool,
} from "../../../packages/server/src/server/plugins/builtin/host-api.js";
import { MEMORY_TEXT_MAX_CHARS } from "../shared/types.js";
import type { MemoryService } from "./service.js";
import { MAX_SEARCH_LIMIT, MemoryInputError } from "./store.js";

const ScopeSchema = z.enum(["project", "global"]);

function json(value: unknown): JAgentDeskToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function failure(error: unknown): JAgentDeskToolResult {
  if (!(error instanceof MemoryInputError)) throw error;
  return {
    content: [{ type: "text", text: JSON.stringify({ error: error.message, code: error.code }) }],
    isError: true,
  };
}

/** `remember`, `search_memory` and `list_memories` (spec 41 §2–§3). None of them calls a model. */
export function registerMemoryTools(
  registerTool: RegisterBuiltinTool,
  service: MemoryService | undefined,
  context: BuiltinToolContext | undefined,
): void {
  if (!service) return;
  const callerAgentId = context?.callerAgentId ?? null;

  registerTool<{ text: string; scope?: "project" | "global"; tags?: string[] }>(
    "remember",
    {
      title: "Remember",
      description: [
        "Save a durable note to JAgentDesk Memory so later agents get it without being told again.",
        "Remember lasting facts: project conventions, decisions and their reasons, the user's preferences, important paths and commands.",
        "Do not remember secrets (tokens, passwords, keys — they are refused), or anything only true for this turn.",
        "One fact per call, written so it reads well on its own. scope 'project' (default) is shared by every agent in this project; 'global' applies in every project on this host (use it for the user's personal preferences).",
        "Saving the same text again updates the existing memory instead of adding a copy.",
      ].join(" "),
      inputSchema: {
        text: z.string().min(1).max(MEMORY_TEXT_MAX_CHARS),
        scope: ScopeSchema.optional(),
        tags: z.array(z.string().max(40)).max(10).optional(),
      },
    },
    async (input) => {
      try {
        const result = await service.remember({
          agentId: callerAgentId,
          text: input.text,
          scope: input.scope ?? "project",
          tags: input.tags,
        });
        return json({ memory: result.memory, deduplicated: result.deduplicated });
      } catch (error) {
        return failure(error);
      }
    },
  );

  registerTool<{ query: string; scope?: "project" | "global"; limit?: number }>(
    "search_memory",
    {
      title: "Search memory",
      description:
        "Full-text search of JAgentDesk Memory (this project's memories and the user's global ones). Relevant memories are already put in front of each user message; search when you need something they did not cover. Matches words, not meaning: try the words a note would use.",
      inputSchema: {
        query: z.string().min(1),
        scope: ScopeSchema.optional(),
        limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional(),
      },
    },
    async (input) => {
      try {
        const memories = await service.search({
          agentId: callerAgentId,
          query: input.query,
          scope: input.scope,
          limit: input.limit,
        });
        return json({ memories });
      } catch (error) {
        return failure(error);
      }
    },
  );

  registerTool<{ scope?: "project" | "global"; tag?: string }>(
    "list_memories",
    {
      title: "List memories",
      description:
        "List JAgentDesk Memory entries for this project and the user's global ones, pinned first, newest first. Filter by scope or tag.",
      inputSchema: {
        scope: ScopeSchema.optional(),
        tag: z.string().optional(),
      },
    },
    async (input) => {
      try {
        const memories = await service.listForAgent({
          agentId: callerAgentId,
          scope: input.scope,
          tag: input.tag,
        });
        return json({ memories });
      } catch (error) {
        return failure(error);
      }
    },
  );
}
