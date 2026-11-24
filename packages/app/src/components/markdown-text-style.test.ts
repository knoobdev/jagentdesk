import { describe, expect, it } from "vitest";
import { StyleSheet, type TextStyle } from "react-native";
import {
  resolveInlineCodeTextStyle,
  resolvePlainMarkdownTextStyle,
} from "@/components/markdown-text-style";

function unistylesStyle(id: string, style: Record<string, unknown>) {
  return {
    ...style,
    [`unistyles_${id}`]: { id },
  };
}

function uiTextViewFlatten(rootStyle: TextStyle, style: TextStyle): Record<string, unknown> {
  // react-native-uitextview/src/util.ts:8 flattens [rootStyle, style]
  // before passing the result to its native View-backed components.
  return { ...(StyleSheet.flatten([rootStyle, style]) as Record<string, unknown>) };
}

function unistylesMetadataKeys(style: Record<string, unknown>) {
  return Object.keys(style).filter((key) => key.startsWith("unistyles_"));
}

describe("resolvePlainMarkdownTextStyle", () => {
  it("keeps UITextView from collapsing parent and child Unistyles styles into one native View style object", () => {
    const merged = uiTextViewFlatten(
      resolvePlainMarkdownTextStyle(unistylesStyle("paragraph", { color: "#111" })),
      resolvePlainMarkdownTextStyle(unistylesStyle("text", { fontWeight: "600" })),
    );

    expect(unistylesMetadataKeys(merged)).toHaveLength(0);
    expect(merged).toMatchObject({ color: "#111", fontWeight: "600" });
  });
});

describe("inline code block scaling (Paseo #7889)", () => {
  it.each([16, 14])(
    "scales heading code using the theme ratio for body size %s",
    (bodyFontSize) => {
      const inherited = {
        fontSize: 28,
        fontWeight: "700" as const,
        fontStyle: "italic" as const,
        lineHeight: 32,
        color: "blue",
      };
      const code = { fontFamily: "monospace", fontSize: 13, backgroundColor: "gray" };
      const merged = resolvePlainMarkdownTextStyle([
        inherited,
        resolveInlineCodeTextStyle(inherited, code, bodyFontSize),
      ]);
      expect(merged).toMatchObject({ ...inherited, ...code, fontSize: (28 * 13) / bodyFontSize });
    },
  );
  it("keeps body code at the theme size and does not mutate shared styles", () => {
    const code = Object.freeze({ fontFamily: "monospace", fontSize: 13 });
    expect(resolveInlineCodeTextStyle({ fontSize: 16 }, code, 16).fontSize).toBe(13);
    expect(resolveInlineCodeTextStyle({ fontSize: 32 }, code, 16).fontSize).toBe(26);
    expect(code.fontSize).toBe(13);
  });
});
