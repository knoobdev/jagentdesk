// What the Telegram dialog shows after "Link my Telegram account" (spec 37.12.1 item 3): the deep
// link and the code while it is valid, then "Linked · {{name}}" once the daemon's status names who
// sent this code (it pushes `bots.changed` when that happens).
import type { TelegramStatus } from "@jagentdesk/protocol/bots/rpc-schemas";

export interface TelegramLinkCode {
  code: string;
  expiresAt_ms: number;
}

export type TelegramLinkView =
  | { kind: "none" }
  | { kind: "pending"; code: string; expiresAt_ms: number; username: string; url: string }
  | { kind: "linked"; name: string };

/** Tapping Start on this link makes Telegram send `/start <code>` to the bot. */
export function telegramDeepLink(username: string, code: string): string {
  return `https://t.me/${encodeURIComponent(username)}?start=${encodeURIComponent(code)}`;
}

export function telegramLinkView(
  code: TelegramLinkCode | null | undefined,
  status: Pick<TelegramStatus, "botUsername" | "linked">,
  now: number,
): TelegramLinkView {
  if (!code) return { kind: "none" };
  if (status.linked?.code === code.code) return { kind: "linked", name: status.linked.user.name };
  if (code.expiresAt_ms <= now || !status.botUsername) return { kind: "none" };
  return {
    kind: "pending",
    code: code.code,
    expiresAt_ms: code.expiresAt_ms,
    username: status.botUsername,
    url: telegramDeepLink(status.botUsername, code.code),
  };
}
