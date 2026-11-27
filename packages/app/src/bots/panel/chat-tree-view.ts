// What the Chats tab and the sidebar tree say about a chat, ported from Orca dfdb4fda (MIT)
// src/shared/bots/bot-chat-tree-view.ts (CHATS_TAB_FIRST_WORKERS, kind labels) and
// src/renderer/src/components/bots/BotChatTreeGroup.tsx:150-170 (the folded counts).
import type { BotChat, BotChatTree, BotChatWorker } from "@jagentdesk/protocol/bots/views";

/** Workers a chat lists before "Show 8 more workers" / "Show {{count}} more workers". */
export const CHAT_WORKERS_STEP = 8;

/** The i18n key of a chat's kind label (spec 37.4.6). */
export function botChatKindKey(kind: BotChat["kind"]): string {
  switch (kind) {
    case "home":
      return "bots.chats.home";
    case "side":
      return "bots.chats.kindSide";
    case "slack":
      return "bots.chats.kindSlack";
    case "github":
      return "bots.chats.kindGithub";
    case "gitlab":
      return "bots.jad.panels.chats.kindGitlab";
    case "telegram":
      return "bots.jad.panels.chats.kindTelegram";
    case "automation":
      return "bots.chats.kindAutomation";
  }
}

/** Home Chat first, then the rest newest first (the daemon already sends `chats` newest first). */
export function orderChatsTab(tree: BotChatTree | undefined): BotChat[] {
  if (!tree) return [];
  const rest = [...tree.chats].sort((a, b) => b.lastActiveAt_ms - a.lastActiveAt_ms);
  return tree.home ? [tree.home, ...rest.filter((chat) => chat.id !== tree.home?.id)] : rest;
}

/** Live workers first (asking, then running), then settled ones newest first. */
export function orderChatWorkers(workers: readonly BotChatWorker[]): BotChatWorker[] {
  const rank = (worker: BotChatWorker) => {
    if (worker.state === "needs-you") return 0;
    return worker.state === "running" ? 1 : 2;
  };
  return [...workers].sort(
    (a, b) =>
      rank(a) - rank(b) || (b.settledAt_ms ?? b.startedAt_ms) - (a.settledAt_ms ?? a.startedAt_ms),
  );
}

/** How many workers show after `steps` presses of "Show more", and how many stay hidden. */
export function chatWorkersShown(
  total: number,
  steps: number,
): { shown: number; hidden: number; next: number } {
  const shown = Math.min(total, CHAT_WORKERS_STEP * (steps + 1));
  const hidden = total - shown;
  return { shown, hidden, next: Math.min(hidden, CHAT_WORKERS_STEP) };
}
