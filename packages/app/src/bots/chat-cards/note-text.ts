// The words of a Home Chat note (spec 37.2.6, 37.4.2), ported from Orca dfdb4fda (MIT)
// src/shared/bots/bot-item-note-lines.ts (the `bots.items.chat.*` verbs) and
// src/renderer/src/components/native-chat/bot-items/NativeChatBotItemNoteRow.tsx.
import type { BotChatNote } from "@jagentdesk/protocol/bots/types";

type Translate = (key: string, values?: Record<string, unknown>) => string;

/** The i18n key of an item note's verb, with `{{items}}` (and `{{status}}` for moves). */
export function itemNoteKey(verb: string | undefined): string {
  switch (verb) {
    case "added":
      return "bots.items.chat.added";
    case "moved":
      return "bots.items.chat.moved";
    case "asked":
      return "bots.items.chat.askedYou";
    case "done":
      return "bots.items.chat.marked";
    case "commented":
      return "bots.items.chat.commented";
    case "canceled":
      return "bots.items.chat.canceled";
    default:
      return "bots.items.chat.updated";
  }
}

/** The run line of a Look around / Tidy memory note, or null for other kinds. */
export function runNoteText(t: Translate, note: BotChatNote): string | null {
  if (note.kind === "look_around") {
    if (note.state === "running") return t("bots.upNext.lookingShort");
    if (note.state === "failed") return t("bots.jad.panels.notes.lookFailed");
    return t("bots.jad.panels.notes.lookedAround", { count: note.count ?? 0 });
  }
  if (note.kind === "tidy_up") {
    if (note.state === "running") return t("bots.settingsBots.tidyUp.tidying");
    if (note.state === "failed") return t("bots.jad.panels.notes.tidyFailed");
    return t("bots.jad.panels.notes.tidied", { count: note.count ?? 0 });
  }
  return null;
}

/** `bots.items.status.*` (Orca keys `needsYou` for `needs_you`). */
export function itemStatusKey(status: NonNullable<BotChatNote["status"]>): string {
  return `bots.items.status.${status === "needs_you" ? "needsYou" : status}`;
}
