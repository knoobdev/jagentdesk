import type { BotItem, BotMessage } from "@jagentdesk/protocol/bots/types";

const itemOrder = { needs_you: 0, working: 1, waiting: 2, planned: 3, done: 4, canceled: 5 };
export function sortItems(items: readonly BotItem[]): BotItem[] {
  return [...items].sort(
    (a, b) =>
      itemOrder[a.status] - itemOrder[b.status] ||
      b.updatedAt_ms - a.updatedAt_ms ||
      a.id.localeCompare(b.id),
  );
}
export function mergeMessages(
  previous: readonly BotMessage[],
  incoming: readonly BotMessage[],
): BotMessage[] {
  const messages = new Map(previous.map((message) => [message.id, message]));
  for (const message of incoming) messages.set(message.id, message);
  return [...messages.values()].sort(
    (a, b) => a.createdAt_ms - b.createdAt_ms || a.id.localeCompare(b.id),
  );
}
export interface BotsDestination {
  botId?: string;
  roomId?: string;
  itemId?: string;
}
export function buildBotsRoute(
  serverId: string,
  target?: BotsDestination,
): `/h/${string}/bots${string}` {
  const params = new URLSearchParams();
  if (target?.botId) params.set("botId", target.botId);
  if (target?.roomId) params.set("roomId", target.roomId);
  if (target?.itemId) {
    params.set("tab", "items");
    params.set("itemId", target.itemId);
  }
  const query = params.toString();
  return `/h/${encodeURIComponent(serverId)}/bots${query ? `?${query}` : ""}`;
}
