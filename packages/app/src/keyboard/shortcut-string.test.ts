import { describe, expect, it } from "vitest";
import {
  keyComboToString,
  keyboardEventToComboString,
  parseShortcutString,
} from "./shortcut-string";

function keyboardEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: "",
    code: "",
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    ...overrides,
  } as KeyboardEvent;
}

describe("keyboardEventToComboString", () => {
  it("captures the Dvorak character rather than its QWERTY position", () => {
    expect(
      keyboardEventToComboString(keyboardEvent({ key: "b", code: "KeyN", metaKey: true })),
    ).toBe("Cmd+B");
  });

  it("captures shifted Dvorak letters and punctuation at other physical positions", () => {
    expect(
      keyboardEventToComboString(
        keyboardEvent({ key: "T", code: "KeyK", metaKey: true, shiftKey: true }),
      ),
    ).toBe("Shift+Cmd+T");
    expect(
      keyboardEventToComboString(keyboardEvent({ key: ";", code: "KeyZ", ctrlKey: true })),
    ).toBe("Ctrl+;");
    expect(
      keyboardEventToComboString(
        keyboardEvent({ key: "?", code: "BracketLeft", ctrlKey: true, shiftKey: true }),
      ),
    ).toBe("Ctrl+Shift+/");
  });

  it("keeps named keys and rewritten Option characters capturable", () => {
    expect(keyboardEventToComboString(keyboardEvent({ key: "ArrowLeft", code: "ArrowLeft" }))).toBe(
      "ArrowLeft",
    );
    expect(
      keyboardEventToComboString(keyboardEvent({ key: "†", code: "KeyT", altKey: true })),
    ).toBe("Alt+T");
  });

  it("does not record a named key that dispatch does not support", () => {
    expect(
      keyboardEventToComboString(
        keyboardEvent({ key: "Enter", code: "NumpadEnter", ctrlKey: true }),
      ),
    ).toBeNull();
  });

  it("captures the minus key (regression: previously returned null)", () => {
    expect(keyboardEventToComboString(keyboardEvent({ key: "-", code: "Minus" }))).toBe("-");
  });

  it("captures minus with modifiers", () => {
    expect(
      keyboardEventToComboString(keyboardEvent({ key: "-", code: "Minus", metaKey: true })),
    ).toBe("Cmd+-");
    expect(
      keyboardEventToComboString(keyboardEvent({ key: "_", code: "Minus", shiftKey: true })),
    ).toBe("Shift+-");
  });

  it("captures equal, semicolon, and quote", () => {
    expect(keyboardEventToComboString(keyboardEvent({ key: "=", code: "Equal" }))).toBe("=");
    expect(keyboardEventToComboString(keyboardEvent({ key: ";", code: "Semicolon" }))).toBe(";");
    expect(keyboardEventToComboString(keyboardEvent({ key: "'", code: "Quote" }))).toBe("'");
  });

  it("still returns null for modifier-only presses", () => {
    expect(keyboardEventToComboString(keyboardEvent({ code: "ShiftLeft" }))).toBeNull();
  });
});

describe("parseShortcutString round-trips punctuation keys", () => {
  const cases: ReadonlyArray<[string, string, string, string]> = [
    ["-", "Minus", "-", "_"],
    ["=", "Equal", "=", "+"],
    [";", "Semicolon", ";", ":"],
    ["'", "Quote", "'", '"'],
  ];

  for (const [humanKey, code, key, shiftedKey] of cases) {
    it(`round-trips ${humanKey}`, () => {
      const combo = parseShortcutString(humanKey);
      expect(combo.code).toBe(code);
      expect(combo.key).toBe(key);
      expect(combo.shiftedKey).toBe(shiftedKey);
      expect(keyComboToString(combo)).toBe(humanKey);
    });
  }

  it("round-trips a modifier combo with minus", () => {
    const combo = parseShortcutString("Cmd+-");
    expect(combo.meta).toBe(true);
    expect(combo.code).toBe("Minus");
    expect(keyComboToString(combo)).toBe("Cmd+-");
  });
});
