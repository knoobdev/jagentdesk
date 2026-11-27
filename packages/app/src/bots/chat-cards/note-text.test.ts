import { describe, expect, it } from "vitest";
import { itemNoteKey, itemStatusKey, runNoteText } from "./note-text";

const t = (key: string, values?: Record<string, unknown>) =>
  values ? `${key}:${String(values.count)}` : key;

describe("home chat notes", () => {
  it("maps item verbs to Orca's keys", () => {
    expect(itemNoteKey("added")).toBe("bots.items.chat.added");
    expect(itemNoteKey("asked")).toBe("bots.items.chat.askedYou");
    expect(itemNoteKey("done")).toBe("bots.items.chat.marked");
    expect(itemNoteKey(undefined)).toBe("bots.items.chat.updated");
    expect(itemStatusKey("needs_you")).toBe("bots.items.status.needsYou");
  });

  it("words Look around and Tidy memory runs", () => {
    expect(runNoteText(t, { kind: "look_around", state: "running" })).toBe(
      "bots.upNext.lookingShort",
    );
    expect(runNoteText(t, { kind: "look_around", state: "done", count: 3 })).toBe(
      "bots.jad.panels.notes.lookedAround:3",
    );
    expect(runNoteText(t, { kind: "tidy_up", state: "running" })).toBe(
      "bots.settingsBots.tidyUp.tidying",
    );
    expect(runNoteText(t, { kind: "tidy_up", state: "failed" })).toBe(
      "bots.jad.panels.notes.tidyFailed",
    );
    expect(runNoteText(t, { kind: "item" })).toBeNull();
  });
});
