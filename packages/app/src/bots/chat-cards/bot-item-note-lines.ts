// What an item note says (spec 37.4.2), ported from Orca dfdb4fda (MIT)
// src/shared/bots/bot-item-note-lines.ts: a quiet line with the item names as chips, the translated
// sentence split around them ("Moved <chips> to In progress"), and the folded run line. Orca's note
// holds many entries; a JAgentDesk note is one change (`BotChatNote`), so the run here is the bot's
// consecutive changes to one item, read as its last change (Orca's `botAct`: the item at its final
// state) and opened into each change.
import type { BotChatNote, BotItem } from "@jagentdesk/protocol/bots/types";
import { itemNoteKey, itemStatusKey } from "./note-text";

type Translate = (key: string, values?: Record<string, unknown>) => string;

export interface BotItemNoteLine {
  lead: string;
  items: BotItem[];
  tail?: string;
  /** Words after the line: a run's count of changes. */
  detail?: string;
  /** The note's own text where its items are gone (deleted since). */
  fallback?: string;
}

/** Where a sentence's chips go: the translated sentence splits there into lead and tail. */
const ITEMS = "";

/** A translated whole sentence as the words around its chips; either side may be empty, so a
 *  translation puts the chips where its grammar wants them. */
function around(sentence: string): Pick<BotItemNoteLine, "lead" | "tail"> {
  const [head = "", rest = ""] = sentence.split(ITEMS);
  const tail = rest.trim();
  return { lead: head.trim(), ...(tail ? { tail } : {}) };
}

export function botItemNoteLine({
  note,
  items,
  fallback,
  t,
}: {
  note: BotChatNote;
  items: ReadonlyMap<string, BotItem>;
  fallback: string;
  t: Translate;
}): BotItemNoteLine {
  const noted = (note.itemIds ?? []).flatMap((id) => {
    const item = items.get(id);
    return item ? [item] : [];
  });
  const sentence = t(itemNoteKey(note.verb), {
    items: ITEMS,
    status: note.status ? t(itemStatusKey(note.status)) : "",
  });
  return {
    ...around(sentence),
    items: noted,
    ...(noted.length === 0 ? { fallback } : {}),
  };
}

/** A folded run of changes to one item: its last change, then how many there were. */
export function botItemNoteRunLine({
  notes,
  items,
  fallback,
  t,
}: {
  notes: readonly BotChatNote[];
  items: ReadonlyMap<string, BotItem>;
  fallback: string;
  t: Translate;
}): BotItemNoteLine {
  const last = notes.at(-1);
  if (!last) throw new Error("A note run needs at least one note");
  return {
    ...botItemNoteLine({ note: last, items, fallback, t }),
    detail: t("bots.jad.items.noteRunChanges", { count: notes.length }),
  };
}

/** The words as plain text, for the row's accessibility name. */
export function botItemNoteLineLabel(line: BotItemNoteLine): string {
  return [
    line.lead,
    line.fallback ?? line.items.map((item) => item.title).join(", "),
    line.tail,
    line.detail,
  ]
    .filter(Boolean)
    .join(" ");
}
