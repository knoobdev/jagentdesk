import { describe, expect, it } from "vitest";
import { firstLookRows } from "./first-look-words";

const t = (key: string, values?: Record<string, unknown>) =>
  values ? `${key} ${JSON.stringify(values)}` : key;

describe("first look rows", () => {
  it("reads every area until the scan answers", () => {
    expect(firstLookRows(undefined, t).map((row) => row.done)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it("names three projects and counts the rest, without GitHub when gh is signed out", () => {
    const rows = firstLookRows(
      {
        projects: { count: 5, names: ["a", "b", "c", "d", "e"] },
        workspaces: { count: 1 },
      },
      t,
    );
    expect(rows.map((row) => row.area)).toEqual(["projects", "workspaces"]);
    expect(rows[0].text).toContain("bots.firstScreen.projectsMany");
    expect(rows[0].text).toContain("bots.firstScreen.namesMore");
    expect(rows[1].text).toBe("bots.firstScreen.workspacesOne");
  });

  it("adds GitHub and MCP rows when the host has them", () => {
    const rows = firstLookRows(
      {
        projects: { count: 0, names: [] },
        github: { openPrs: 1 },
        workspaces: { count: 0 },
        mcp: { count: 2, names: ["x", "y"] },
      },
      t,
    );
    expect(rows.map((row) => row.text)).toEqual([
      "bots.firstScreen.projectsNone",
      "bots.firstScreen.githubOne",
      "bots.firstScreen.workspacesNone",
      'bots.firstScreen.toolsMany {"count":2,"names":"x, y"}',
    ]);
  });
});
