// What a bot's permission card says when it asks to start a worker or reach another bot (spec
// 37.3.2-37.3.3). Orca's card for a worker start shows the command the bot ran, which names the
// item, the project (`--repo`), a new worktree and the task (`--spec`) (Orca dfdb4fda, MIT:
// src/main/bots/bot-preamble.ts:50,72; NativeChatApprovalCard.tsx:83-86,271-292). JAgentDesk's bot
// starts a worker with a tool, so the card says the same things in words.
//
// The daemon writes English `title`/`description` for clients that don't read the card, and puts
// the facts in the request's existing optional `metadata` under `botCard`; the app reads them back
// with `readBotPermissionCard` and words the card in the user's language.

/** The facts of a bot's permission card, under the request's `metadata.botCard`. */
export type BotPermissionCard =
  | {
      kind: "worker_start";
      botName: string;
      /** The item's `#N`, when it has one. */
      itemNumber: number | null;
      itemTitle: string;
      /** The project folder the worker's new worktree branches off. */
      projectPath: string;
      /** The project folder's name. */
      projectName: string;
      /** What the worker is asked to do. */
      task: string;
    }
  | {
      kind: "handoff";
      botName: string;
      toBotName: string;
      type: "status" | "handoff" | "question";
      text: string;
    };

export const BOT_PERMISSION_CARD_KEY = "botCard";

export interface BotPermissionRequestText {
  title: string;
  description: string;
  /** Shown under the description, as the request's plain-text detail. */
  detail: { type: "plain_text"; label: string; text: string };
  metadata: { [BOT_PERMISSION_CARD_KEY]: BotPermissionCard };
}

/** A path's last folder name. */
export function botProjectName(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  return parts.at(-1) ?? path;
}

function itemLabel(card: { itemNumber: number | null; itemTitle: string }): string {
  return card.itemNumber === null ? card.itemTitle : `#${card.itemNumber} ${card.itemTitle}`;
}

const HANDOFF_TITLES: Record<
  Extract<BotPermissionCard, { kind: "handoff" }>["type"],
  (to: string) => string
> = {
  handoff: (to) => `Hand this to ${to}?`,
  question: (to) => `Ask ${to}?`,
  status: (to) => `Send ${to} a status?`,
};

/** The English card, as clients that don't read `botCard` show it. */
export function botPermissionRequestText(card: BotPermissionCard): BotPermissionRequestText {
  const metadata = { [BOT_PERMISSION_CARD_KEY]: card };
  if (card.kind === "worker_start") {
    return {
      title: `Start a worker for ${itemLabel(card)}?`,
      description: `${card.botName} starts a worker in a new worktree of ${card.projectName} (${card.projectPath}). The worker reports back when it is done.`,
      detail: { type: "plain_text", label: "Task", text: card.task },
      metadata,
    };
  }
  return {
    title: HANDOFF_TITLES[card.type](card.toBotName),
    description: `${card.botName} sends ${card.toBotName} this message.`,
    detail: { type: "plain_text", label: "Message", text: card.text },
    metadata,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** The card a request's `metadata` carries; null for any other request. */
export function readBotPermissionCard(metadata: unknown): BotPermissionCard | null {
  const card = isRecord(metadata) ? metadata[BOT_PERMISSION_CARD_KEY] : null;
  if (!isRecord(card)) return null;
  const botName = str(card.botName);
  if (botName === null) return null;
  if (card.kind === "worker_start") {
    const itemTitle = str(card.itemTitle);
    const projectPath = str(card.projectPath);
    const projectName = str(card.projectName);
    const task = str(card.task);
    if (itemTitle === null || projectPath === null || projectName === null || task === null)
      return null;
    const itemNumber = typeof card.itemNumber === "number" ? card.itemNumber : null;
    return {
      kind: "worker_start",
      botName,
      itemNumber,
      itemTitle,
      projectPath,
      projectName,
      task,
    };
  }
  if (card.kind === "handoff") {
    const toBotName = str(card.toBotName);
    const text = str(card.text);
    const type = card.type;
    if (toBotName === null || text === null) return null;
    if (type !== "status" && type !== "handoff" && type !== "question") return null;
    return { kind: "handoff", botName, toBotName, type, text };
  }
  return null;
}
