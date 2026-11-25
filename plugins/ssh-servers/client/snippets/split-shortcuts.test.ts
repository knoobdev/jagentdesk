import { describe, expect, it } from "vitest";
import { splitShortcutFor, type ShortcutKeyEvent } from "./split-shortcuts";

function key(partial: Partial<ShortcutKeyEvent> & { key: string }): ShortcutKeyEvent {
  return { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...partial };
}

describe("splitShortcutFor", () => {
  it("maps Cmd+B and Cmd+Opt+arrows on macOS", () => {
    const mac = { isMac: true };
    expect(splitShortcutFor(key({ key: "b", metaKey: true }), mac)).toEqual({
      kind: "toggle-broadcast",
    });
    expect(splitShortcutFor(key({ key: "ArrowLeft", metaKey: true, altKey: true }), mac)).toEqual({
      kind: "focus",
      direction: "left",
    });
    expect(splitShortcutFor(key({ key: "b", ctrlKey: true, altKey: true }), mac)).toBeNull();
  });

  it("maps Ctrl+Alt+B and Ctrl+Alt+arrows elsewhere", () => {
    const other = { isMac: false };
    expect(splitShortcutFor(key({ key: "B", ctrlKey: true, altKey: true }), other)).toEqual({
      kind: "toggle-broadcast",
    });
    expect(splitShortcutFor(key({ key: "ArrowDown", ctrlKey: true, altKey: true }), other)).toEqual(
      { kind: "focus", direction: "down" },
    );
    expect(splitShortcutFor(key({ key: "b", metaKey: true }), other)).toBeNull();
    expect(
      splitShortcutFor(key({ key: "b", ctrlKey: true, altKey: true, shiftKey: true }), other),
    ).toBeNull();
  });
});
