import { describe, expect, it } from "vitest";
import { resolveCloseAgentTabPolicy } from "./close-tab-policy";

describe("resolveCloseAgentTabPolicy", () => {
  it("archives root agents when their tab closes", () => {
    expect(resolveCloseAgentTabPolicy({ parentAgentId: null })).toEqual({
      kind: "archive-on-close",
    });
  });

  it("keeps subagent tab close layout-only", () => {
    expect(resolveCloseAgentTabPolicy({ parentAgentId: "parent-agent" })).toEqual({
      kind: "layout-only",
    });
  });

  it("keeps a bot's own agent: closing its tab never archives the bot", () => {
    expect(
      resolveCloseAgentTabPolicy({ parentAgentId: null, labels: { "jagentdesk.bot.id": "bot_1" } }),
    ).toEqual({ kind: "layout-only" });
  });

  it("preserves the existing archive fallback when the agent is missing", () => {
    expect(resolveCloseAgentTabPolicy(null)).toEqual({ kind: "archive-on-close" });
    expect(resolveCloseAgentTabPolicy(undefined)).toEqual({ kind: "archive-on-close" });
  });
});
