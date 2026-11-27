// The Home Chat's note rows (spec 37.4.2), ported from Orca dfdb4fda (MIT)
// src/renderer/src/components/native-chat/bot-items/native-chat-bot-item-note-clusters.ts:
// consecutive changes to the same item fold into one row; any other note ends the run. A long run
// splits into rows of a few notes, counted from the run's first note, so a live note only changes
// the last row.
import type { BotMessage } from "@jagentdesk/protocol/bots/types";

/** Notes per folded row. */
export const MAX_ITEM_NOTE_RUN = 8;

export type BotNoteRow =
  | { kind: "note"; message: BotMessage }
  | { kind: "run"; itemId: string; messages: BotMessage[] };

/** The one item an item note names, or null. */
function soleItem(message: BotMessage): string | null {
  const note = message.note;
  if (note?.kind !== "item" || note.itemIds?.length !== 1) return null;
  return note.itemIds[0] ?? null;
}

export function botNoteRows(messages: readonly BotMessage[]): BotNoteRow[] {
  const rows: BotNoteRow[] = [];
  let run: { itemId: string; messages: BotMessage[] } | null = null;
  const flush = () => {
    if (!run) return;
    const [first] = run.messages;
    // A lone change is its own row.
    if (run.messages.length === 1 && first) rows.push({ kind: "note", message: first });
    else rows.push({ kind: "run", itemId: run.itemId, messages: run.messages });
    run = null;
  };
  for (const message of messages) {
    const itemId = soleItem(message);
    if (itemId === null) {
      flush();
      rows.push({ kind: "note", message });
      continue;
    }
    if (run && (run.itemId !== itemId || run.messages.length === MAX_ITEM_NOTE_RUN)) flush();
    if (run) run.messages.push(message);
    else run = { itemId, messages: [message] };
  }
  flush();
  return rows;
}

/** A row's key: its first note's id, which a later note joining the run does not change. */
export function botNoteRowKey(row: BotNoteRow): string {
  return row.kind === "note" ? row.message.id : `run:${row.messages[0]?.id ?? row.itemId}`;
}
