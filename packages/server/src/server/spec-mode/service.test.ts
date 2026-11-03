import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostCapabilities } from "@jagentdesk/protocol/host-capabilities";
import type { SpecModeState } from "@jagentdesk/protocol/spec-mode";
import type { AgentManagerEvent } from "../agent/agent-manager.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { SpecModeRequestError, SpecModeService, type SpecModeAgentManager } from "./service.js";

const AVAILABLE: HostCapabilities = {
  specKit: { state: "available", reason: "", version: null, installable: [] },
};

const FILLED_CONSTITUTION =
  "# Todo Constitution\n\n## Core Principles\n\n### I. Simple\nKeep it small.\n";

interface FakeAgent {
  cwd: string;
  provider: string;
}

/** In-memory AgentManager slice: tests play the agent by writing files and ending turns. */
class FakeAgents implements SpecModeAgentManager {
  readonly agents = new Map<string, FakeAgent>();
  readonly reloads: string[] = [];
  lastAssistantMessage: string | null = null;
  private readonly subscribers = new Set<(event: AgentManagerEvent) => void>();

  getAgent(agentId: string): FakeAgent | null {
    return this.agents.get(agentId) ?? null;
  }
  getBaseProviderId(provider: string): string {
    return provider;
  }
  subscribe(callback: (event: AgentManagerEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }
  hasInFlightRun(): boolean {
    return false;
  }
  async getLastAssistantMessage(): Promise<string | null> {
    return this.lastAssistantMessage;
  }
  async reloadAgentSession(agentId: string): Promise<unknown> {
    this.reloads.push(agentId);
    return null;
  }
  completeTurn(agentId: string): void {
    for (const subscriber of this.subscribers) {
      subscriber({
        type: "agent_stream",
        agentId,
        event: { type: "turn_completed", provider: "claude" },
      });
    }
  }
}

interface Harness {
  service: SpecModeService;
  agents: FakeAgents;
  /** Phase commands the daemon sent on Approve/Revise. */
  sent: { agentId: string; text: string }[];
  states: SpecModeState[];
  autorunActive: Set<string>;
}

let workspace: string;
let home: string;
let harness: Harness;

async function write(relativePath: string, content: string): Promise<void> {
  const target = path.join(workspace, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

function createHarness(capabilities: HostCapabilities = AVAILABLE): Harness {
  const agents = new FakeAgents();
  const sent: { agentId: string; text: string }[] = [];
  const states: SpecModeState[] = [];
  const autorunActive = new Set<string>();
  const service = new SpecModeService({
    jagentdeskHome: home,
    logger: createTestLogger(),
    agentManager: agents,
    hostCapabilities: { snapshot: () => capabilities, refresh: async () => capabilities },
    isAutorunActive: async (agentId) => autorunActive.has(agentId),
    sendPrompt: async (agentId, text) => {
      sent.push({ agentId, text });
    },
    onState: (state) => states.push(state),
    platform: "darwin",
    homeDir: path.join(home, "user-home"),
    now: () => 1_700_000_000_000,
  });
  return { service, agents, sent, states, autorunActive };
}

/** Let the turn_completed handler (queued behind the agent's lock) finish. */
async function settle(agentId: string): Promise<SpecModeState> {
  return harness.service.get(agentId);
}

async function hashTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else
        out[path.relative(dir, full)] = createHash("sha256")
          .update(await readFile(full))
          .digest("hex");
    }
  }
  await walk(dir);
  return out;
}

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "spec-mode-ws-"));
  home = await mkdtemp(path.join(tmpdir(), "spec-mode-home-"));
  harness = createHarness();
  harness.agents.agents.set("agent_a", { cwd: workspace, provider: "claude" });
  await harness.service.initialize();
});

afterEach(async () => {
  harness.service.stop();
  await rm(workspace, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

async function enableWithSetup(agentId = "agent_a"): Promise<SpecModeState> {
  return harness.service.set({ agentId, enabled: true, confirmSetup: true });
}

describe("Spec mode setup (spec 28.3)", () => {
  it("lists the files first and writes nothing until the user confirms", async () => {
    const preview = await harness.service.preview("agent_a");
    expect(preview.missingTools).toEqual([]);
    expect(preview.files).toContain(".claude/skills/speckit-specify/SKILL.md");
    expect(preview.files).toContain(".specify/scripts/bash/common.sh");
    expect(preview.files).toContain(".specify/init-options.json");

    await expect(harness.service.set({ agentId: "agent_a", enabled: true })).rejects.toMatchObject({
      code: "setup_required",
    });
    expect(existsSync(path.join(workspace, ".specify"))).toBe(false);

    const state = await enableWithSetup();
    expect(state.enabled).toBe(true);
    for (const file of preview.files) expect(existsSync(path.join(workspace, file))).toBe(true);
    const skill = await readFile(
      path.join(workspace, ".claude/skills/speckit-specify/SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("disable-model-invocation: true");
    expect((await stat(path.join(workspace, ".specify/scripts/bash/common.sh"))).mode & 0o777).toBe(
      0o755,
    );
  });

  it("never overwrites a .specify/ the user already has (criterion 5)", async () => {
    await write(".specify/memory/constitution.md", FILLED_CONSTITUTION);
    await write(
      ".specify/init-options.json",
      '{"script": "sh", "feature_numbering": "timestamp"}\n',
    );
    await write(".specify/scripts/bash/common.sh", "#!/usr/bin/env bash\n# the user's own copy\n");
    const before = await hashTree(path.join(workspace, ".specify"));

    const preview = await harness.service.preview("agent_a");
    expect(preview.files.every((file) => file.startsWith(".claude/skills/"))).toBe(true);
    await enableWithSetup();

    expect(await hashTree(path.join(workspace, ".specify"))).toEqual(before);
    expect(existsSync(path.join(workspace, ".claude/skills/speckit-plan/SKILL.md"))).toBe(true);
  });

  it("uses speckit skills the user installed instead of writing them", async () => {
    await write(".specify/memory/constitution.md", FILLED_CONSTITUTION);
    const userSkill = path.join(home, "user-home", ".claude", "skills", "speckit-plan", "SKILL.md");
    await mkdir(path.dirname(userSkill), { recursive: true });
    await writeFile(userSkill, "---\nname: speckit-plan\n---\nmine\n");
    const preview = await harness.service.preview("agent_a");
    expect(preview.files).not.toContain(".claude/skills/speckit-plan/SKILL.md");
    expect(preview.files).toContain(".claude/skills/speckit-tasks/SKILL.md");
  });

  it("refuses with missing_tools when the host lacks jq and python3 (criterion 6)", async () => {
    harness.service.stop();
    harness = createHarness({
      specKit: {
        state: "missing_tool",
        reason: "Requires jq or python3",
        version: null,
        installable: ["jq"],
      },
    });
    harness.agents.agents.set("agent_a", { cwd: workspace, provider: "claude" });
    expect((await harness.service.preview("agent_a")).missingTools).toEqual([
      "Requires jq or python3",
    ]);
    await expect(enableWithSetup()).rejects.toEqual(
      new SpecModeRequestError("missing_tools", "Requires jq or python3"),
    );
    expect(existsSync(path.join(workspace, ".specify"))).toBe(false);
  });

  it("refuses with autorun_active while autonomous mode drives the agent (criterion 7)", async () => {
    harness.autorunActive.add("agent_a");
    await expect(enableWithSetup()).rejects.toMatchObject({ code: "autorun_active" });
  });
});

describe("Spec mode phases (spec 28.4)", () => {
  beforeEach(async () => {
    await enableWithSetup();
    await write(".specify/memory/constitution.md", FILLED_CONSTITUTION);
    // Re-enable so the filled constitution is seen as done (skipped).
    await harness.service.set({ agentId: "agent_a", enabled: false });
    await harness.service.set({ agentId: "agent_a", enabled: true });
  });

  async function playSpecify(): Promise<void> {
    await write("specs/001-todo-cli/spec.md", "# Feature Specification: Todo CLI\n");
    await write(".specify/feature.json", '{\n  "feature_directory": "specs/001-todo-cli"\n}\n');
    harness.agents.completeTurn("agent_a");
  }

  it("sends Specify, waits for review, then Plan only on Approve (criterion 2)", async () => {
    const initial = await harness.service.get("agent_a");
    expect(initial.phase).toBe("specify");
    expect(initial.phaseStatus.constitution).toBe("skipped");

    const message = await harness.service.prepareUserMessage("agent_a", "a todo CLI");
    expect(message).toEqual({ phase: "specify", text: "/speckit-specify a todo CLI" });

    await playSpecify();
    const reviewing = await settle("agent_a");
    expect(reviewing.phaseStatus.specify).toBe("awaiting_review");
    expect(reviewing.featureDirectory).toBe("specs/001-todo-cli");
    expect(reviewing.reviewFiles).toEqual(["specs/001-todo-cli/spec.md"]);
    expect(harness.sent).toEqual([]);

    const approved = await harness.service.review({ agentId: "agent_a", decision: "approve" });
    expect(harness.sent).toEqual([{ agentId: "agent_a", text: "/speckit-plan" }]);
    expect(approved.phase).toBe("plan");
    expect(approved.phaseStatus.specify).toBe("done");
    expect(approved.phaseStatus.clarify).toBe("skipped");
    expect(approved.phaseStatus.plan).toBe("running");
  });

  it("keeps Specify running while the agent waits for answers", async () => {
    await harness.service.prepareUserMessage("agent_a", "a todo CLI");
    await write("specs/001-todo-cli/spec.md", "- FR-001 [NEEDS CLARIFICATION: storage?]\n");
    await write(".specify/feature.json", '{"feature_directory": "specs/001-todo-cli"}');
    harness.agents.completeTurn("agent_a");
    expect((await settle("agent_a")).phaseStatus.specify).toBe("running");
    // The user's answer goes to the agent unchanged.
    expect(await harness.service.prepareUserMessage("agent_a", "Q1: A")).toBeNull();
    await write("specs/001-todo-cli/spec.md", "- FR-001 store tasks in a local file\n");
    harness.agents.completeTurn("agent_a");
    expect((await settle("agent_a")).phaseStatus.specify).toBe("awaiting_review");
  });

  it("re-sends only the current phase with the note on Revise (criterion 3)", async () => {
    await harness.service.prepareUserMessage("agent_a", "a todo CLI");
    await playSpecify();
    await settle("agent_a");
    await harness.service.review({ agentId: "agent_a", decision: "approve" });
    await write("specs/001-todo-cli/plan.md", "# Plan\n");
    await write("specs/001-todo-cli/research.md", "# Research\n");
    harness.agents.completeTurn("agent_a");
    expect((await settle("agent_a")).phaseStatus.plan).toBe("awaiting_review");

    const revised = await harness.service.review({
      agentId: "agent_a",
      decision: "revise",
      note: "Use SQLite instead of a JSON file",
    });
    expect(harness.sent.map((entry) => entry.text)).toEqual([
      "/speckit-plan",
      "/speckit-plan Use SQLite instead of a JSON file",
    ]);
    expect(revised.phaseStatus.specify).toBe("done");
    expect(revised.phaseStatus.plan).toBe("running");
  });

  it("refuses a review when no phase is waiting", async () => {
    await expect(
      harness.service.review({ agentId: "agent_a", decision: "approve" }),
    ).rejects.toMatchObject({ code: "not_awaiting_review" });
  });

  it("finishes as Converged when converge leaves tasks.md unchanged (criterion 4)", async () => {
    await harness.service.prepareUserMessage("agent_a", "a todo CLI");
    await playSpecify();
    await settle("agent_a");
    await harness.service.review({ agentId: "agent_a", decision: "approve" });
    await write("specs/001-todo-cli/plan.md", "# Plan\n");
    await write("specs/001-todo-cli/research.md", "# Research\n");
    harness.agents.completeTurn("agent_a");
    await settle("agent_a");
    await harness.service.review({ agentId: "agent_a", decision: "approve" });
    await write("specs/001-todo-cli/tasks.md", "## Phase 1: Setup\n\n- [ ] T001 Create cli.py\n");
    harness.agents.completeTurn("agent_a");
    expect((await settle("agent_a")).phaseStatus.tasks).toBe("awaiting_review");
    await harness.service.review({ agentId: "agent_a", decision: "approve" });
    await write("specs/001-todo-cli/tasks.md", "## Phase 1: Setup\n\n- [X] T001 Create cli.py\n");
    harness.agents.completeTurn("agent_a");
    expect((await settle("agent_a")).phaseStatus.implement).toBe("awaiting_review");
    await harness.service.review({ agentId: "agent_a", decision: "approve" });

    // Converge appends work → back to Implement after approval.
    await write(
      "specs/001-todo-cli/tasks.md",
      "## Phase 1: Setup\n\n- [X] T001 Create cli.py\n\n## Phase 2: Convergence\n\n- [ ] T002 Add --help per spec.md FR-002 (missing)\n",
    );
    harness.agents.completeTurn("agent_a");
    expect((await settle("agent_a")).phaseStatus.converge).toBe("awaiting_review");
    await harness.service.review({ agentId: "agent_a", decision: "approve" });
    expect(harness.sent.at(-1)?.text).toBe("/speckit-implement");
    await write(
      "specs/001-todo-cli/tasks.md",
      "## Phase 1: Setup\n\n- [X] T001 Create cli.py\n\n## Phase 2: Convergence\n\n- [X] T002 Add --help per spec.md FR-002 (missing)\n",
    );
    harness.agents.completeTurn("agent_a");
    await settle("agent_a");
    await harness.service.review({ agentId: "agent_a", decision: "approve" });
    expect(harness.sent.at(-1)?.text).toBe("/speckit-converge");

    // Converge without touching tasks.md: Converged.
    harness.agents.completeTurn("agent_a");
    const finished = await settle("agent_a");
    expect(finished.converged).toBe(true);
    expect(finished.phase).toBeNull();
    expect(finished.phaseStatus).toEqual({
      constitution: "skipped",
      specify: "done",
      clarify: "skipped",
      plan: "done",
      checklist: "skipped",
      tasks: "done",
      analyze: "skipped",
      implement: "done",
      converge: "done",
    });
  });

  it("sends no phase after Spec mode is turned off and resumes on re-enable", async () => {
    await harness.service.prepareUserMessage("agent_a", "a todo CLI");
    await harness.service.set({ agentId: "agent_a", enabled: false });
    await playSpecify();
    const off = await settle("agent_a");
    expect(off.phaseStatus.specify).toBe("running");
    expect(await harness.service.prepareUserMessage("agent_a", "hello")).toBeNull();

    const resumed = await harness.service.set({ agentId: "agent_a", enabled: true });
    expect(resumed.phaseStatus.specify).toBe("awaiting_review");
    expect(harness.sent).toEqual([]);
  });

  it("starts model turns only for user messages and Approve/Revise (criterion 9)", async () => {
    const userTurns = 1;
    expect(await harness.service.prepareUserMessage("agent_a", "a todo CLI")).not.toBeNull();
    await playSpecify();
    await settle("agent_a");
    harness.agents.completeTurn("agent_a");
    harness.agents.completeTurn("agent_a");
    await settle("agent_a");
    await harness.service.review({ agentId: "agent_a", decision: "approve" });
    harness.agents.completeTurn("agent_a");
    await settle("agent_a");
    await write("specs/001-todo-cli/plan.md", "# Plan\n");
    await write("specs/001-todo-cli/research.md", "# Research\n");
    harness.agents.completeTurn("agent_a");
    await settle("agent_a");
    await harness.service.review({ agentId: "agent_a", decision: "revise", note: "shorter" });
    harness.agents.completeTurn("agent_a");
    await settle("agent_a");
    // 1 user message + 2 button presses = 3 turns; turn completions added none.
    expect(userTurns + harness.sent.length).toBe(3);
  });
});

describe("Two agents in one checkout (criterion 8)", () => {
  it("gives each agent its own feature directory and never writes feature.json", async () => {
    await write(".specify/memory/constitution.md", FILLED_CONSTITUTION);
    harness.agents.agents.set("agent_b", { cwd: workspace, provider: "claude" });
    await enableWithSetup("agent_a");
    await enableWithSetup("agent_b");

    const first = await harness.service.prepareUserMessage("agent_a", "a todo CLI");
    const second = await harness.service.prepareUserMessage("agent_b", "a weather dashboard");
    expect(first?.text).toContain("/speckit-specify a todo CLI");
    expect(first?.text).toContain("`specs/001-todo-cli`");
    expect(second?.text).toContain("`specs/002-weather-dashboard`");
    expect(harness.service.launchEnv("agent_a")).toEqual({
      SPECIFY_FEATURE_NO_PERSIST: "1",
      SPECIFY_FEATURE_DIRECTORY: "specs/001-todo-cli",
    });
    expect(harness.service.launchEnv("agent_b")).toEqual({
      SPECIFY_FEATURE_NO_PERSIST: "1",
      SPECIFY_FEATURE_DIRECTORY: "specs/002-weather-dashboard",
    });
    expect(harness.agents.reloads).toEqual(["agent_a", "agent_b"]);

    await write("specs/001-todo-cli/spec.md", "# Todo CLI\n");
    await write("specs/002-weather-dashboard/spec.md", "# Weather dashboard\n");
    harness.agents.completeTurn("agent_a");
    harness.agents.completeTurn("agent_b");
    expect((await settle("agent_a")).phaseStatus.specify).toBe("awaiting_review");
    expect((await settle("agent_b")).phaseStatus.specify).toBe("awaiting_review");
    expect(existsSync(path.join(workspace, ".specify/feature.json"))).toBe(false);
  });
});
