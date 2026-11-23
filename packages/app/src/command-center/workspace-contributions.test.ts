import { describe, expect, it } from "vitest";
import type { GitAction, GitActions } from "@/git/policy";
import type { KeyboardActionDefinition } from "@/keyboard/keyboard-action-dispatcher";
import {
  buildWorkspaceCommandCenterContributions,
  type WorkspaceCommandCenterSource,
} from "./workspace-contributions";

function gitAction(id: GitAction["id"], label: string): GitAction {
  return {
    id,
    label,
    pendingLabel: `${label} pending`,
    successLabel: `${label} complete`,
    disabled: false,
    status: "idle",
    startsGroup: false,
    handler: () => undefined,
  };
}

function source(gitActions: GitActions): {
  value: WorkspaceCommandCenterSource;
  runGitActions: GitAction[];
  dispatched: KeyboardActionDefinition[];
  archivedWorkspaces: number;
} {
  const runGitActions: GitAction[] = [];
  const dispatched: KeyboardActionDefinition[] = [];
  let archivedWorkspaces = 0;
  return {
    get archivedWorkspaces() {
      return archivedWorkspaces;
    },
    value: {
      gitActions,
      labels: {
        section: "Workspace actions",
        newAgent: "New agent",
        newTerminal: "New terminal",
        newBrowser: "New browser",
        splitRight: "Split pane right",
        splitDown: "Split pane down",
        archiveWorkspace: "Archive workspace",
      },
      icons: {},
      shortcuts: {},
      capabilities: {
        isGit: gitActions.primary !== null || gitActions.secondary.length > 0,
        canSplitPanes: true,
        canOpenBrowserTabs: true,
      },
      dispatch: (action) => dispatched.push(action),
      runGitAction: (action) => runGitActions.push(action),
      archiveWorkspace: () => {
        archivedWorkspaces += 1;
      },
    },
    runGitActions,
    dispatched,
  };
}

describe("workspace command center contributions", () => {
  it("offers archive in a non-Git workspace and runs the workspace's archive", () => {
    const fixture = source({ primary: null, secondary: [], menu: [] });

    const archive = buildWorkspaceCommandCenterContributions(fixture.value).find(
      (item) => item.id === "workspace:archive",
    );

    expect(archive?.visibility).toBe("query");
    expect(archive?.presentation).toMatchObject({ title: "Archive workspace" });
    archive?.run();
    expect(fixture.archivedWorkspaces).toBe(1);
    expect(fixture.dispatched).toEqual([]);
  });

  it("omits archive while the workspace cannot be archived", () => {
    const fixture = source({ primary: null, secondary: [], menu: [] });
    fixture.value.archiveWorkspace = null;

    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);

    expect(contributions.some((item) => item.id === "workspace:archive")).toBe(false);
  });

  it("lists archive once in a Git workspace, through its Git action", () => {
    const archive = gitAction("archive-workspace", "Archive workspace");
    const fixture = source({ primary: null, secondary: [archive], menu: [] });
    fixture.value.capabilities.isGit = true;

    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);

    expect(
      contributions.filter((item) => item.id.includes("archive")).map((item) => item.id),
    ).toEqual(["git:archive-workspace"]);
  });

  it("makes only the policy-selected primary Git action default-visible and runs it", () => {
    const primary = gitAction("commit", "Commit");
    const fixture = source({
      primary,
      secondary: [gitAction("push", "Push")],
      menu: [],
    });

    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);
    const gitContributions = contributions.filter((item) => item.id.startsWith("git:"));
    const defaultGitContributions = gitContributions.filter((item) => item.visibility === "always");

    expect(defaultGitContributions.map((item) => item.id)).toEqual(["git:commit"]);
    defaultGitContributions[0].run();
    expect(fixture.runGitActions).toEqual([primary]);
  });

  it("does not duplicate a primary action retained in the secondary policy list", () => {
    const primary = gitAction("pull", "Pull");
    const fixture = source({
      primary,
      secondary: [primary, gitAction("push", "Push")],
      menu: [],
    });

    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);

    expect(contributions.filter((item) => item.id === "git:pull")).toHaveLength(1);
  });

  it("orders New agent before Git and keeps terminal, browser, and splits search-only", () => {
    const fixture = source({
      primary: gitAction("commit", "Commit"),
      secondary: [],
      menu: [],
    });

    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);

    expect(contributions.map(({ id, rank, visibility }) => ({ id, rank, visibility }))).toEqual([
      { id: "tab:new-agent", rank: 0, visibility: "always" },
      { id: "git:commit", rank: 1, visibility: "always" },
      { id: "tab:new-terminal", rank: 2, visibility: "query" },
      { id: "tab:new-browser", rank: 3, visibility: "query" },
      { id: "pane:split-right", rank: 4, visibility: "query" },
      { id: "pane:split-down", rank: 5, visibility: "query" },
    ]);
  });

  it("omits browser and split actions when their existing capabilities are unavailable", () => {
    const fixture = source({ primary: null, secondary: [], menu: [] });
    fixture.value.capabilities = { isGit: false, canSplitPanes: false, canOpenBrowserTabs: false };

    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);

    expect(contributions.map((item) => item.id)).toEqual([
      "tab:new-agent",
      "tab:new-terminal",
      "workspace:archive",
    ]);
  });

  it("dispatches every tab and pane command to the workspace scope", () => {
    const fixture = source({ primary: null, secondary: [], menu: [] });
    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);

    for (const contribution of contributions) contribution.run();

    expect(fixture.dispatched).toEqual([
      { id: "workspace.tab.new", scope: "workspace" },
      { id: "workspace.terminal.new", scope: "workspace" },
      { id: "workspace.browser.new", scope: "workspace" },
      { id: "workspace.pane.split.right", scope: "workspace" },
      { id: "workspace.pane.split.down", scope: "workspace" },
    ]);
  });

  it("keeps workspace creation commands available outside Git", () => {
    const fixture = source({ primary: null, secondary: [], menu: [] });

    const contributions = buildWorkspaceCommandCenterContributions(fixture.value);

    expect(contributions.map((item) => item.id)).toEqual([
      "tab:new-agent",
      "tab:new-terminal",
      "tab:new-browser",
      "pane:split-right",
      "pane:split-down",
      "workspace:archive",
    ]);
    expect(contributions.some((item) => item.id.startsWith("git:"))).toBe(false);
  });
});
