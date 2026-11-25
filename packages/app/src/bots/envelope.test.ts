import { describe, expect, it } from "vitest";
import { botIdFromLabels, stripBotEnvelope } from "./envelope";

describe("stripBotEnvelope", () => {
  it("drops the source line the daemon prefixes", () => {
    expect(stripBotEnvelope("[chat]\nHi! What can you do?")).toBe("Hi! What can you do?");
    expect(stripBotEnvelope("[slack.mention]\nline one\nline two")).toBe("line one\nline two");
  });

  it("keeps text without an envelope", () => {
    expect(stripBotEnvelope("[not an envelope] same line")).toBe("[not an envelope] same line");
    expect(stripBotEnvelope("plain text")).toBe("plain text");
    expect(stripBotEnvelope("body\n[chat]\nlater")).toBe("body\n[chat]\nlater");
  });
});

describe("botIdFromLabels", () => {
  it("reads the supervisor label", () => {
    expect(botIdFromLabels({ "jagentdesk.bot.id": "b1" })).toBe("b1");
    expect(botIdFromLabels({})).toBeNull();
    expect(botIdFromLabels(undefined)).toBeNull();
  });
});
