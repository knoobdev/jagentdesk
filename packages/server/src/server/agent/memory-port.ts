import type { AgentPromptContentBlock, AgentPromptInput } from "./agent-sdk-types.js";

/**
 * Relevant memories for one user turn (spec 41 §3.1). The Memory built-in provides this port;
 * prompt delivery puts `block` in front of the provider message and calls `commit` once the
 * daemon accepted the turn, which records the use and shows the "Used N memories" chip.
 */
export interface MemoryTurnInjection {
  block: Extract<AgentPromptContentBlock, { type: "text"; mimeType: "text/plain" }>;
  memoryIds: readonly string[];
  commit(input: { messageId?: string | null }): Promise<void>;
}

export interface MemoryPort {
  /** Null when Memory or auto-inject is off, or nothing passes the relevance threshold. */
  prepareUserTurn(input: { agentId: string; text: string }): Promise<MemoryTurnInjection | null>;
  /** The spec 42 switches, kept with the Memory settings (Settings → Memory). */
  durableSettings(): DurableContextSettings;
}

/** Spec 42 §8 switches. All on by default; the daemon uses the defaults without Memory. */
export interface DurableContextSettings {
  regroundAfterCompaction: boolean;
  recitation: boolean;
  ledgerNudge: boolean;
  learnFromCorrections: boolean;
  lessonExpiry: boolean;
}

export const DEFAULT_DURABLE_CONTEXT_SETTINGS: DurableContextSettings = {
  regroundAfterCompaction: true,
  recitation: true,
  ledgerNudge: true,
  learnFromCorrections: true,
  lessonExpiry: true,
};

/** A memory block the prompt already carries (session.ts put it there for a person's message). */
export function hasMemoryBlock(prompt: AgentPromptInput): boolean {
  if (typeof prompt === "string") return false;
  return prompt.some(
    (block) => block.type === "text" && "title" in block && block.title === MEMORY_BLOCK_TITLE,
  );
}

export const MEMORY_BLOCK_TITLE = "Relevant memories";

/**
 * Puts the memory block first, as a text attachment so the user's bubble shows only what they
 * typed. A turn that leads with a command (an attached skill's `/name`, a spec-kit phase) keeps
 * the command first, so the block goes last instead.
 */
export function withMemoryBlock(
  prompt: AgentPromptInput,
  injection: MemoryTurnInjection | null,
  options: { commandFirst: boolean },
): AgentPromptInput {
  if (!injection) return prompt;
  let blocks: AgentPromptContentBlock[] = [];
  if (typeof prompt !== "string") blocks = prompt;
  else if (prompt) blocks = [{ type: "text", text: prompt }];
  return options.commandFirst ? [...blocks, injection.block] : [injection.block, ...blocks];
}

/** Text that leads with a slash/dollar command must stay first for the provider. */
export function startsWithCommand(text: string): boolean {
  return /^\s*[/$]\S/.test(text);
}
