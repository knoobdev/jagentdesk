import { describe, expect, it } from "vitest";
import type { BotMessage } from "./types.js";
import { BOT_CREATED_KICKOFF, botFirstScreenState, isBotKickoffMessage } from "./rules.js";

let at = 0;
function line(role: BotMessage["role"], source: string, text: string, id = `m${++at}`): BotMessage {
  return { id, botId: "b1", role, source, text, createdAt_ms: ++at };
}
const kickoff = (id = "b1:created:b1") => line("system", "jagentdesk", BOT_CREATED_KICKOFF, id);

describe("botFirstScreenState (Orca nativeChatFirstScreen)", () => {
  it("is starting from the kickoff until the bot speaks", () => {
    expect(botFirstScreenState([kickoff()])).toEqual({
      phase: "starting",
      kickoffId: "b1:created:b1",
    });
    expect(
      botFirstScreenState([kickoff(), line("assistant", "done", "Hi! What first?")]),
    ).toBeNull();
  });

  it("is null for a chat without a kickoff, or once the owner wrote", () => {
    expect(botFirstScreenState([])).toBeNull();
    expect(botFirstScreenState([line("user", "chat", "hi")])).toBeNull();
    expect(botFirstScreenState([kickoff(), line("user", "chat", "Look at my PRs")])).toBeNull();
  });

  it("fails with the line about why when the turn ended without words", () => {
    expect(botFirstScreenState([kickoff(), line("assistant", "error", "Not logged in")])).toEqual({
      phase: "failed",
      kickoffId: "b1:created:b1",
      failure: "Not logged in",
    });
    // A reply that is only the quiet marker says nothing.
    expect(botFirstScreenState([kickoff(), line("assistant", "done", "[[quiet]]")])).toMatchObject({
      phase: "starting",
    });
  });

  it("reads the latest kickoff: Try again starts over", () => {
    expect(
      botFirstScreenState([
        kickoff(),
        line("assistant", "error", "The first turn ended without a reply."),
        kickoff("b1:created:b1:retry:1"),
      ]),
    ).toEqual({ phase: "starting", kickoffId: "b1:created:b1:retry:1" });
  });

  it("knows a template's kickoff and ignores other daemon lines", () => {
    expect(
      isBotKickoffMessage(
        line(
          "system",
          "jagentdesk",
          `${BOT_CREATED_KICKOFF} You were made from the Reviewer template.`,
        ),
      ),
    ).toBe(true);
    expect(isBotKickoffMessage(line("user", "chat", BOT_CREATED_KICKOFF))).toBe(false);
    expect(isBotKickoffMessage(line("system", "restart", BOT_CREATED_KICKOFF))).toBe(false);
  });
});
