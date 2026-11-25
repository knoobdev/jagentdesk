import { randomUUID } from "node:crypto";
import type { BotItem, BotItemPatch } from "@jagentdesk/protocol/bots/types";
import { BotItemPatchSchema } from "@jagentdesk/protocol/bots/types";

const TRANSITIONS: Record<BotItem["status"], readonly BotItem["status"][]> = {
  planned: ["working", "waiting", "needs_you", "done", "canceled"],
  working: ["waiting", "needs_you", "done", "canceled"],
  waiting: ["working", "needs_you", "canceled"],
  needs_you: ["working", "waiting", "canceled"],
  done: [],
  canceled: [],
};
export function patchItem(item: BotItem, raw: BotItemPatch, reviewed = false): BotItem {
  const patch = BotItemPatchSchema.parse(raw);
  const status = patch.status ?? item.status;
  if (status !== item.status && !TRANSITIONS[item.status].includes(status))
    throw new Error(`Invalid item transition ${item.status} → ${status}`);
  if (["done", "canceled"].includes(item.status)) throw new Error("Item is closed");
  if (status === "done" && item.workerAgentIds.length > 0 && !reviewed)
    throw new Error("Worker items must pass daemon cross-review before done");
  if (status === "waiting" && !(patch.waitFor ?? item.waitFor))
    throw new Error("Waiting needs a condition and wake deadline");
  const questions = patch.questions ?? item.questions;
  for (const q of questions ?? []) {
    if (q.recommended !== undefined && q.recommended >= q.options.length)
      throw new Error("Recommended option is out of range");
  }
  return {
    ...item,
    ...patch,
    status,
    ...(status !== "waiting" ? { waitFor: undefined } : {}),
    ...(status !== "needs_you" ? { questions: undefined } : {}),
    updatedAt_ms: Date.now(),
  };
}
export function commentItem(item: BotItem, text: string, author: string): BotItem {
  if (!text.trim() || text.length > 40000)
    throw new Error("Comment must contain 1–40000 characters");
  return {
    ...item,
    comments: [...item.comments, { id: randomUUID(), text, author, createdAt_ms: Date.now() }],
  };
}
