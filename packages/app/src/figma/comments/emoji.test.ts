import { describe, expect, it } from "vitest";
import { renderEmoji } from "./emoji";

describe("renderEmoji", () => {
  it("maps Figma's standard shortcodes to Unicode glyphs", () => {
    expect(renderEmoji(":+1:")).toBe("👍");
    expect(renderEmoji(":-1:")).toBe("👎");
    expect(renderEmoji(":tada:")).toBe("🎉");
    expect(renderEmoji(":fire:")).toBe("🔥");
    expect(renderEmoji(":eyes:")).toBe("👀");
    expect(renderEmoji(":rocket:")).toBe("🚀");
  });

  it("keeps literal emoji untouched", () => {
    expect(renderEmoji("🎉")).toBe("🎉");
  });

  it("shows unknown shortcodes verbatim instead of dropping them", () => {
    expect(renderEmoji(":pickle:")).toBe(":pickle:");
    expect(renderEmoji("plain text")).toBe("plain text");
  });
});
