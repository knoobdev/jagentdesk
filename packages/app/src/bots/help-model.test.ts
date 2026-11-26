import { describe, expect, it } from "vitest";
import { botsStrings } from "@/i18n/resources/bots";
import { NAME_SLOT, helpSegments, howToAskKeys } from "./help-model";

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? "");
}

describe("How to ask (spec 37 §37.5.2, A37.5.6)", () => {
  it("shows only the Chat line while Slack is not connected", () => {
    expect(howToAskKeys(false)).toEqual(["bots.help.chat"]);
  });

  it("adds the Slack line once the bot's Slack app is connected", () => {
    expect(howToAskKeys(true)).toEqual(["bots.help.chat", "bots.help.slack"]);
  });

  it("sets the mention as code and fills in the bot name", () => {
    const translated = fill(botsStrings.help.slack, { name: NAME_SLOT });
    expect(helpSegments(translated, "heocon")).toEqual([
      { text: "Mention ", code: false, start: 0 },
      { text: "@heocon", code: true, start: 8 },
      { text: " in a channel, or send it a direct message.", code: false, start: 23 },
    ]);
  });

  it("keeps a bot name holding markup as plain text", () => {
    const translated = fill(botsStrings.help.chat, { name: NAME_SLOT });
    expect(helpSegments(translated, "<code>x</code>")).toEqual([
      {
        text: "Type what you need. <code>x</code> plans it as Items and asks you when it needs a decision.",
        code: false,
        start: 0,
      },
    ]);
  });
});

describe("helper wording (spec 37 §37.5.2)", () => {
  it("uses the spec's sentences", () => {
    expect(botsStrings.help).toMatchObject({
      open: "How bots work",
      teammate: "Your AI teammate",
      step1: "1. Create a bot — give it a name and pick the agent that does the work.",
      step2: "2. Talk to it in Chat, or mention it in Slack.",
      step3:
        "3. It tracks the work as Items and asks you under Needs you when it needs a decision.",
      name: "Shown in chat and Slack.",
      slug: "Used in mentions and the bot's folder. Lowercase letters, numbers and hyphens.",
      identity: "Optional. Who it is and what it does — it starts SOUL.md.",
      agent: "The agent that does the work for this bot.",
      repo: "Optional. Where it starts work when you don't name a project.",
      unattended: "Runs tools without asking you first. Use only for bots you trust.",
      howToAsk: "How to ask",
    });
  });
});
