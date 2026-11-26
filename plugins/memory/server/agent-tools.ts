import { z } from "zod";
import type {
  BuiltinToolContext,
  JAgentDeskToolResult,
  RegisterBuiltinTool,
} from "../../../packages/server/src/server/plugins/builtin/host-api.js";
import {
  MAX_CITATIONS,
  MAX_EXCERPT_CHARS,
  MEMORY_TEXT_MAX_CHARS,
  type MemoryCitation,
} from "../shared/types.js";
import type { MemoryService } from "./service.js";
import { MAX_SEARCH_LIMIT, MemoryInputError } from "./store.js";

const ScopeSchema = z.enum(["project", "global"]);
const CitationSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe("File that shows the lesson is true, relative to the project root."),
  symbol: z.string().optional().describe("Function, key or section in that file."),
  excerpt: z
    .string()
    .max(MAX_EXCERPT_CHARS)
    .optional()
    .describe("A short exact quote from the file; the lesson is dropped once it disappears."),
});

interface RememberInput {
  text: string;
  scope?: "project" | "global";
  tags?: string[];
  kind?: "memory" | "lesson";
  citations?: MemoryCitation[];
  status?: "active" | "pending";
}

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

  registerTool<RememberInput>(
    "remember",
    {
      title: "Remember",
      description: [
        "Save a durable note to JAgentDesk Memory so later agents get it without being told again.",
        "Remember lasting facts: project conventions, decisions and their reasons, the user's preferences, important paths and commands.",
        "Do not remember secrets (tokens, passwords, keys — they are refused), or anything only true for this turn.",
        "One fact per call, written so it reads well on its own. scope 'project' (default) is shared by every agent in this project; 'global' applies in every project on this host (use it for the user's personal preferences).",
        "Saving the same text again updates the existing memory instead of adding a copy.",
        'kind "lesson": something you learned because the user corrected you, or because you found you were wrong and confirmed the right way. Save it in the same turn, only once the right way is confirmed, written as the rule to follow, with citations: the file that proves it (and if you can, a short exact excerpt). JAgentDesk checks the citations before each use and drops the lesson when they stop holding.',
        'status "pending" is only for lessons saved when the user asks you to capture lessons; the user approves them.',
      ].join(" "),
      inputSchema: {
        text: z.string().min(1).max(MEMORY_TEXT_MAX_CHARS),
        scope: ScopeSchema.optional(),
        tags: z.array(z.string().max(40)).max(10).optional(),
        kind: z.enum(["memory", "lesson"]).optional(),
        citations: z.array(CitationSchema).max(MAX_CITATIONS).optional(),
        status: z.enum(["active", "pending"]).optional(),
      },
    },
    async (input) => {
      try {
        const result = await service.remember({
          agentId: callerAgentId,
          text: input.text,
          scope: input.scope ?? "project",
          tags: input.tags,
          kind: input.kind,
          citations: input.citations,
          status: input.status,
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

  registerTool<{ id: string; helpful: boolean }>(
    "rate_memory",
    {
      title: "Rate memory",
      description:
        "Tell JAgentDesk whether a memory or lesson you were given (its id is in the relevant-memories block or a search result) helped (helpful true) or misled you (helpful false). Rate only after it clearly mattered for this task. Helpful ratings keep a lesson alive; repeated unhelpful ratings retire it.",
      inputSchema: {
        id: z.string().min(1),
        helpful: z.boolean(),
      },
    },
    async (input) => {
      try {
        const memory = service.rate({ id: input.id, helpful: input.helpful });
        return json({
          memory: {
            id: memory.id,
            status: memory.status,
            helpful: memory.helpful,
            harmful: memory.harmful,
          },
        });
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
