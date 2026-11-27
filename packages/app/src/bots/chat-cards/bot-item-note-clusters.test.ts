import { describe, expect, it } from "vitest";
import type { BotChatNote, BotItem, BotMessage } from "@jagentdesk/protocol/bots/types";
import { botNoteRowKey, botNoteRows, MAX_ITEM_NOTE_RUN } from "./bot-item-note-clusters";
import { botItemNoteLine, botItemNoteLineLabel, botItemNoteRunLine } from "./bot-item-note-lines";

let sequence = 0;
function noteMessage(note: BotChatNote, text = "note"): BotMessage {
  sequence += 1;
  return {
    id: `bot-1:note:${sequence}`,
    botId: "bot-1",
    role: "system",
    text,
    source: "jagentdesk",
    createdAt_ms: sequence,
    note,
  };
}

function itemNote(verb: string, itemIds: string[], status?: BotChatNote["status"]): BotMessage {
  return noteMessage({ kind: "item", verb, itemIds, ...(status ? { status } : {}) });
}

function item(id: string, title: string, status: BotItem["status"]): BotItem {
  return {
    id,
    botId: "bot-1",
    title,
    doneMeans: "",
    status,
    workerAgentIds: [],
    comments: [],
    reviewRounds: 0,
    reviews: [],
    createdAt_ms: 0,
    updatedAt_ms: 0,
  } as BotItem;
}

// Echoes the key and its values, with the chips' slot shown as [items].
function t(key: string, values?: Record<string, unknown>): string {
  const templates: Record<string, string> = {
    "bots.items.chat.moved": "Moved {{items}} to {{status}}",
    "bots.items.chat.commented": "Commented on {{items}}",
    "bots.items.chat.marked": "Marked {{items}} done",
    "bots.items.status.working": "In progress",
    "bots.items.status.done": "Done",
    "bots.jad.items.noteRunChanges": "· {{count}} changes",
  };
  const template = templates[key] ?? key;
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? ""));
}

describe("bot item note rows", () => {
  it("folds consecutive changes to one item into one row (the reported Moved/Commented/Marked)", () => {
    const moved = itemNote("moved", ["item-2"], "working");
    const commented = itemNote("commented", ["item-2"]);
    const marked = itemNote("done", ["item-2"], "done");
    const tidied = noteMessage({ kind: "tidy_up", state: "done", count: 0 });

    const rows = botNoteRows([moved, commented, marked, tidied]);

    expect(rows.map((row) => row.kind)).toEqual(["run", "note"]);
    expect(rows[0]).toEqual({
      kind: "run",
      itemId: "item-2",
      messages: [moved, commented, marked],
    });
    expect(botNoteRowKey(rows[0]!)).toBe(`run:${moved.id}`);
  });

  it("keeps a lone change, a different item and a bulk note as their own rows", () => {
    const first = itemNote("moved", ["item-1"], "working");
    const second = itemNote("moved", ["item-2"], "working");
    const bulk = itemNote("added", ["item-3", "item-4"]);
    const again = itemNote("done", ["item-3"], "done");

    const rows = botNoteRows([first, second, bulk, again]);

    expect(rows.map((row) => row.kind)).toEqual(["note", "note", "note", "note"]);
  });

  it("splits a long run into rows of a few notes counted from its first note", () => {
    const run = Array.from({ length: MAX_ITEM_NOTE_RUN + 2 }, () =>
      itemNote("commented", ["item-1"]),
    );

    const rows = botNoteRows(run);

    expect(rows.map((row) => (row.kind === "run" ? row.messages.length : 1))).toEqual([
      MAX_ITEM_NOTE_RUN,
      2,
    ]);
  });
});

describe("bot item note lines", () => {
  const items = new Map([
    ["item-2", item("item-2", "#2 Làm đẹp lại giao diện trang Todo", "done")],
    ["item-3", item("item-3", "Three", "planned")],
  ]);

  it("splits the sentence around the chips", () => {
    const line = botItemNoteLine({
      note: { kind: "item", verb: "moved", itemIds: ["item-2"], status: "working" },
      items,
      fallback: "Moved #2",
      t,
    });

    expect(line.lead).toBe("Moved");
    expect(line.tail).toBe("to In progress");
    expect(line.items.map((entry) => entry.id)).toEqual(["item-2"]);
    expect(line.fallback).toBeUndefined();
  });

  it("reads a run as its last change and how many changes there were", () => {
    const line = botItemNoteRunLine({
      notes: [
        { kind: "item", verb: "moved", itemIds: ["item-2"], status: "working" },
        { kind: "item", verb: "commented", itemIds: ["item-2"] },
        { kind: "item", verb: "done", itemIds: ["item-2"], status: "done" },
      ],
      items,
      fallback: "Marked #2 done",
      t,
    });

    expect(botItemNoteLineLabel(line)).toBe(
      "Marked #2 Làm đẹp lại giao diện trang Todo done · 3 changes",
    );
  });

  it("falls back to the note's own words when its items are gone", () => {
    const line = botItemNoteLine({
      note: { kind: "item", verb: "commented", itemIds: ["deleted"] },
      items,
      fallback: "Commented on #9",
      t,
    });

    expect(line.items).toEqual([]);
    expect(line.fallback).toBe("Commented on #9");
  });
});
