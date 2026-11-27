import { describe, expect, it } from "vitest";
import {
  resolveEmptyWorkspaceDraftSeed,
  type EmptyWorkspaceDraftSeedInput,
} from "./workspace-empty-draft-seed";

const WORKSPACE_KEY = "srv:ws";

const readyEmptyWorkspace: EmptyWorkspaceDraftSeedInput = {
  workspaceKey: WORKSPACE_KEY,
  seededWorkspaceKey: null,
  isRouteFocused: true,
  hasPersistenceKey: true,
  hasWorkspaceDirectory: true,
  hasHydratedWorkspaceLayoutStore: true,
  hasHydratedAgents: true,
  hasLoadedTerminals: true,
  activeAgentCount: 0,
  terminalCount: 0,
  tabCount: 0,
};

/** Feeds successive renders through the decision the way the screen effect does. */
function runRenders(renders: Array<Partial<EmptyWorkspaceDraftSeedInput>>): number {
  let seededWorkspaceKey: string | null = null;
  let seeds = 0;
  for (const render of renders) {
    const decision = resolveEmptyWorkspaceDraftSeed({
      ...readyEmptyWorkspace,
      ...render,
      seededWorkspaceKey,
    });
    seededWorkspaceKey = decision.seededWorkspaceKey;
    if (decision.seed) seeds += 1;
  }
  return seeds;
}

describe("resolveEmptyWorkspaceDraftSeed", () => {
  it("waits for refresh-time hydration before seeding a draft", () => {
    for (const flag of [
      "hasHydratedWorkspaceLayoutStore",
      "hasHydratedAgents",
      "hasLoadedTerminals",
      "isRouteFocused",
    ] as const) {
      expect(resolveEmptyWorkspaceDraftSeed({ ...readyEmptyWorkspace, [flag]: false }).seed).toBe(
        false,
      );
    }
  });

  it("does not seed when existing workspace content is known", () => {
    expect(
      resolveEmptyWorkspaceDraftSeed({ ...readyEmptyWorkspace, activeAgentCount: 1 }).seed,
    ).toBe(false);
    expect(resolveEmptyWorkspaceDraftSeed({ ...readyEmptyWorkspace, terminalCount: 1 }).seed).toBe(
      false,
    );
    expect(resolveEmptyWorkspaceDraftSeed({ ...readyEmptyWorkspace, tabCount: 1 }).seed).toBe(
      false,
    );
  });

  it("seeds once an empty focused workspace is fully known", () => {
    expect(resolveEmptyWorkspaceDraftSeed(readyEmptyWorkspace)).toEqual({
      seed: true,
      seededWorkspaceKey: WORKSPACE_KEY,
    });
  });

  it("seeds one draft while readiness flickers and the workspace stays empty", () => {
    // Closing the last tab, then agent/terminal refreshes toggling readiness before the draft lands.
    expect(
      runRenders([
        { tabCount: 1 },
        {},
        { hasHydratedAgents: false },
        {},
        { hasLoadedTerminals: false },
        {},
        { isRouteFocused: false },
        {},
      ]),
    ).toBe(1);
  });

  it("seeds one draft when the last agent is archived after its tab closed", () => {
    expect(
      runRenders([{ tabCount: 1, activeAgentCount: 1 }, { activeAgentCount: 1 }, {}, {}]),
    ).toBe(1);
  });

  it("seeds again after the seeded draft was shown and then closed", () => {
    expect(runRenders([{}, { tabCount: 1 }, {}])).toBe(2);
  });

  it("seeds for a different workspace shown by the same screen", () => {
    expect(runRenders([{}, { workspaceKey: "srv:other" }])).toBe(2);
  });
});
