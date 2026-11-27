import { describe, expect, it } from "vitest";
import {
  botEnvelopeSource,
  botIdFromLabels,
  isBotKickoffWake,
  isBotRestartWake,
  stripBotEnvelope,
  stripBotQuietMarker,
} from "./envelope";

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

describe("isBotRestartWake", () => {
  it("knows the daemon's restart turn and nothing the owner typed", () => {
    expect(botEnvelopeSource("[restart]\nJAgentDesk restarted, so…")).toBe("restart");
    expect(isBotRestartWake("[restart]\nJAgentDesk restarted, so…")).toBe(true);
    expect(isBotRestartWake("[resume]\nThe daemon resumed.")).toBe(true);
    expect(isBotRestartWake("[chat]\n[restart]\nhi")).toBe(false);
    expect(isBotRestartWake("restart")).toBe(false);
  });
});

describe("isBotKickoffWake", () => {
  it("knows the daemon's kickoff turn, a template's too, and not the owner's words", () => {
    const kickoff = "JAgentDesk: you were just created. Start your first-run setup.";
    expect(isBotKickoffWake(`[jagentdesk]\n${kickoff}`)).toBe(true);
    expect(
      isBotKickoffWake(`[jagentdesk]\n${kickoff} You were made from the Reviewer template.`),
    ).toBe(true);
    expect(isBotKickoffWake(`[chat]\n${kickoff}`)).toBe(false);
    expect(isBotKickoffWake(kickoff)).toBe(false);
    expect(isBotKickoffWake("[jagentdesk]\nAdded #1")).toBe(false);
  });
});

describe("botIdFromLabels", () => {
  it("reads the supervisor label", () => {
    expect(botIdFromLabels({ "jagentdesk.bot.id": "b1" })).toBe("b1");
    expect(botIdFromLabels({})).toBeNull();
    expect(botIdFromLabels(undefined)).toBeNull();
  });
});

describe("stripBotQuietMarker", () => {
  it("hides a reply that only says the quiet marker and trims a trailing one", () => {
    expect(stripBotQuietMarker("[[quiet]]")).toBe("");
    expect(stripBotQuietMarker("Done with #3.\n[[quiet]]  ")).toBe("Done with #3.");
    expect(stripBotQuietMarker("Talk about [[quiet]] later.")).toBe("Talk about [[quiet]] later.");
  });
});
