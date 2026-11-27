import { describe, expect, it } from "vitest";
import { botConnectorRows, botConnectorsNeedFix } from "./connector-rows";

describe("connector rows", () => {
  it("lists Slack, GitHub, GitLab, Telegram in order", () => {
    expect(botConnectorRows({}).map((row) => row.name)).toEqual([
      "Slack",
      "GitHub",
      "GitLab",
      "Telegram",
    ]);
  });

  it("counts the connectors that need fixing", () => {
    const bot = {
      slack: { connected: true, needsFix: true },
      github: { connected: true },
      telegram: { connected: false, needsFix: true },
    };
    expect(botConnectorsNeedFix(bot)).toBe(2);
    const rows = botConnectorRows(bot);
    expect(rows[0]).toMatchObject({ connected: true, needsFix: true });
    expect(rows[2]).toMatchObject({ connected: false, needsFix: false });
  });
});
