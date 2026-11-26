import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { createIdleRuntimeCleanup } from "./idle-runtime-cleanup/index.js";
import { startAgentRun } from "./agent-prompt.js";
import { diffHostToolSets, type HostToolSetSource } from "./host-tool-set.js";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  JAgentDeskToolsHealth,
} from "./agent-sdk-types.js";

const logger = createTestLogger();

const CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: true,
  supportsSessionListing: false,
  supportsDynamicModes: false,
  supportsMcpServers: true,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

class TurnSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = CAPABILITIES;
  readonly id = randomUUID();
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private turns = 0;

  constructor(
    readonly config: Partial<AgentSessionConfig>,
    private readonly resumable: boolean,
    private readonly health?: ToolHealthScript,
  ) {}

  async checkJAgentDeskTools(): Promise<JAgentDeskToolsHealth> {
    if (!this.health) return { status: "unknown" };
    this.health.checks += 1;
    return this.health.answers.shift() ?? { status: "ok" };
  }

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    const turnId = `turn-${this.id}-${++this.turns}`;
    setTimeout(() => {
      this.push({ type: "turn_started", provider: this.provider, turnId });
      this.push({
        type: "timeline",
        provider: this.provider,
        turnId,
        item: { type: "user_message", text: typeof prompt === "string" ? prompt : "structured" },
      });
      this.push({ type: "turn_completed", provider: this.provider, turnId });
    }, 0);
    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  private push(event: AgentStreamEvent): void {
    for (const callback of this.subscribers) callback(event);
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id, model: null, modeId: null };
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode() {
    return null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions() {
    return [];
  }

  async respondToPermission(): Promise<void> {}

  describePersistence() {
    return this.resumable
      ? { provider: this.provider, sessionId: this.id }
      : { provider: this.provider, sessionId: "" };
  }

  async interrupt(): Promise<void> {}

  closed = false;

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** What successive runtimes answer when the manager asks for their JAgentDesk tools. */
interface ToolHealthScript {
  answers: JAgentDeskToolsHealth[];
  checks: number;
}

class RecordingClient implements AgentClient {
  health: ToolHealthScript | undefined;
  readonly provider = "codex" as const;
  readonly capabilities = CAPABILITIES;
  readonly created: AgentSessionConfig[] = [];
  private current: TurnSession | undefined;
  readonly resumed: Array<{
    handle: AgentPersistenceHandle;
    config?: Partial<AgentSessionConfig>;
    launchContext?: AgentLaunchContext;
  }> = [];

  constructor(private readonly resumable = true) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async fetchCatalog() {
    return { models: [], modes: [] };
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    this.created.push(config);
    this.current = new TurnSession(config, this.resumable, this.health);
    return this.current;
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    config?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    // Like Codex: a persisted thread accepts one writer at a time.
    if (this.current && !this.current.closed)
      throw new Error("thread already has an active writer");
    this.resumed.push({ handle, config, launchContext });
    this.current = new TurnSession(config ?? {}, this.resumable, this.health);
    return this.current;
  }
}

/** Mirrors the built-in source: a per-agent snapshot that a launch moves to the host's set. */
class FakeHostToolSet implements HostToolSetSource {
  host = new Set<string>();
  readonly snapshots = new Map<string, ReadonlySet<string>>();

  launched(agentId: string): ReadonlySet<string> {
    return this.snapshots.get(agentId) ?? new Set(this.host);
  }

  current(): ReadonlySet<string> {
    return new Set(this.host);
  }

  adopt(agentId: string): void {
    this.snapshots.set(agentId, new Set(this.host));
  }

  inAppBrowser(agentId: string): boolean {
    return this.launched(agentId).has("browser-tools");
  }

  /** Launch hints of connected integrations, as the Jira built-in contributes them. */
  hints: string[] = [];
  connectors: string[] = [];

  instructions(agentId: string): string[] {
    return [
      this.launched(agentId).has("browser-tools")
        ? "Browse with browser_* tools."
        : "Browser tools are off; call turn_on_host_tools.",
      ...this.hints,
    ];
  }

  replacedProviderConnectors(): string[] {
    return [...this.connectors];
  }
}

const workdirs: string[] = [];
afterEach(() => {
  for (const dir of workdirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function setup(
  options: { resumable?: boolean; health?: ToolHealthScript; storage?: boolean } = {},
) {
  const workdir = mkdtempSync(join(tmpdir(), "agent-host-tools-"));
  workdirs.push(workdir);
  const client = new RecordingClient(options.resumable ?? true);
  client.health = options.health;
  const hostToolSet = new FakeHostToolSet();
  const registry = options.storage ? new AgentStorage(join(workdir, "agents"), logger) : undefined;
  const manager = new AgentManager({
    clients: { codex: client },
    ...(registry ? { registry } : {}),
    logger,
    mcpBaseUrl: "http://127.0.0.1:1/mcp/agents",
    hostToolSet,
    providerLabel: () => "Codex",
  });
  const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });
  const turn = async (prompt: string) => {
    await startAgentRun(manager, agent.id, prompt, logger);
    await vi.waitFor(() => expect(manager.hasInFlightRun(agent.id)).toBe(false));
  };
  const userMessages = () =>
    manager
      .getTimeline(agent.id)
      .filter((item) => item.type === "user_message")
      .map((item) => (item.type === "user_message" ? item.text : ""));
  const notifications = () =>
    manager
      .getTimeline(agent.id)
      .flatMap((item) => (item.type === "notification" ? [item.message] : []));
  return { manager, client, hostToolSet, agent, turn, userMessages, notifications, registry };
}

describe("diffHostToolSets", () => {
  test("reports added and removed tool groups, sorted", () => {
    expect(
      diffHostToolSets(
        new Set(["docker", "skills"]),
        new Set(["skills", "browser-tools", "argocd"]),
      ),
    ).toEqual({ added: ["argocd", "browser-tools"], removed: ["docker"] });
  });

  test("is null when the sets match, whatever the order", () => {
    expect(diffHostToolSets(new Set(["a", "b"]), new Set(["b", "a"]))).toBeNull();
  });
});

describe("host tool groups change mid-session (spec 04 §27b.1)", () => {
  test("turning on browser tools resumes the same native session before the next turn", async () => {
    const { manager, client, hostToolSet, agent, turn, userMessages } = await setup();
    const firstSessionId = manager.getAgent(agent.id)!.persistence!.sessionId;
    expect(client.created[0]?.daemonAppendSystemPrompt).toContain("turn_on_host_tools");

    await turn("one");
    await turn("two");
    await turn("three");
    expect(client.resumed).toHaveLength(0);

    hostToolSet.host.add("browser-tools");
    await turn("open example.org with the browser");

    expect(client.resumed).toHaveLength(1);
    expect(client.resumed[0]?.handle.sessionId).toBe(firstSessionId);
    expect(client.resumed[0]?.config?.daemonAppendSystemPrompt).toContain("browser_*");
    expect(hostToolSet.launched(agent.id).has("browser-tools")).toBe(true);
    expect(manager.getAgent(agent.id)?.id).toBe(agent.id);
    expect(userMessages()).toEqual(["one", "two", "three", "open example.org with the browser"]);
  });

  test("a built-in turned off mid-session also reaches the next turn", async () => {
    const { client, hostToolSet, agent, turn } = await setup();
    hostToolSet.host.add("docker");
    await turn("one");
    expect(client.resumed).toHaveLength(1);
    hostToolSet.host.delete("docker");
    await turn("two");
    expect(client.resumed).toHaveLength(2);
    expect(hostToolSet.launched(agent.id).has("docker")).toBe(false);
  });

  test("an unchanged tool set keeps the running runtime", async () => {
    const { client, turn } = await setup();
    await turn("one");
    await turn("two");
    expect(client.resumed).toHaveLength(0);
  });

  test("before the first turn a session without a native id simply starts again", async () => {
    const { client, hostToolSet, agent, turn, notifications } = await setup({ resumable: false });
    hostToolSet.host.add("browser-tools");
    await turn("open example.org with the browser");
    // Relaunched once with the new tools; the fake reports an empty native id.
    const launches = [...client.created, ...client.resumed.map((entry) => entry.config ?? {})];
    expect(launches).toHaveLength(2);
    expect(launches[1]?.daemonAppendSystemPrompt).toContain("browser_*");
    expect(hostToolSet.launched(agent.id).has("browser-tools")).toBe(true);
    expect(notifications()).toEqual([]);
  });

  test("a session that cannot resume keeps its tools and says so once", async () => {
    const { client, hostToolSet, agent, turn, userMessages, notifications } = await setup({
      resumable: false,
    });
    await turn("one");
    hostToolSet.host.add("browser-tools");
    await turn("two");
    await turn("three");

    expect(client.resumed).toHaveLength(0);
    expect(client.created).toHaveLength(1);
    expect(hostToolSet.launched(agent.id).has("browser-tools")).toBe(false);
    expect(notifications()).toEqual(["New tools apply from a new session for Codex"]);
    expect(userMessages()).toEqual(["one", "two", "three"]);
  });
});

describe("launch hints follow the host mid-session (spec 29.4)", () => {
  test("a Jira connection added mid-session reaches the next turn with its connectors hidden", async () => {
    const { client, hostToolSet, turn, userMessages } = await setup();
    await turn("one");
    expect(client.resumed).toHaveLength(0);

    hostToolSet.hints = ["Jira: use the JAgentDesk jira_* tools."];
    hostToolSet.connectors = ["atlassian"];
    await turn("get ABC-1");

    expect(client.resumed).toHaveLength(1);
    expect(client.resumed[0]?.config?.daemonAppendSystemPrompt).toContain("jira_* tools");
    expect(client.resumed[0]?.launchContext?.hideProviderConnectors).toEqual(["atlassian"]);
    await turn("again");
    expect(client.resumed).toHaveLength(1);
    expect(userMessages()).toEqual(["one", "get ABC-1", "again"]);
  });
});

describe("JAgentDesk tools do not drop mid-session (spec 04 §27b.0, A4.27b.5)", () => {
  test("tools present: the turn runs on the same runtime", async () => {
    const health: ToolHealthScript = { answers: [], checks: 0 };
    const { client, turn, notifications } = await setup({ health });
    await turn("one");
    await turn("two");
    expect(health.checks).toBe(2);
    expect(client.resumed).toHaveLength(0);
    expect(notifications()).toEqual([]);
  });

  test("tools missing: the runtime resumes the same session with a fresh MCP config", async () => {
    const health: ToolHealthScript = {
      answers: [{ status: "missing", reason: "the jagentdesk MCP server is failed" }],
      checks: 0,
    };
    const { manager, client, agent, turn, userMessages, notifications } = await setup({
      health,
    });
    const sessionId = manager.getAgent(agent.id)!.persistence!.sessionId;
    await turn("use argocd");

    expect(health.checks).toBe(2);
    expect(client.resumed).toHaveLength(1);
    expect(client.resumed[0]?.handle.sessionId).toBe(sessionId);
    const mcp = client.resumed[0]?.config?.mcpServers?.jagentdesk;
    expect(mcp?.type === "http" ? mcp.url : null).toBe(
      `http://127.0.0.1:1/mcp/agents?callerAgentId=${agent.id}`,
    );
    expect(manager.getAgent(agent.id)?.id).toBe(agent.id);
    expect(userMessages()).toEqual(["use argocd"]);
    expect(notifications()).toEqual([]);
  });

  test("still missing after one restart: one timeline row with the reason", async () => {
    const missing: JAgentDeskToolsHealth = {
      status: "missing",
      reason: "the jagentdesk MCP server is failed: 401",
    };
    const health: ToolHealthScript = {
      answers: [missing, missing, missing, missing],
      checks: 0,
    };
    const { client, turn, userMessages, notifications } = await setup({ health });
    await turn("one");
    await turn("two");

    expect(client.resumed).toHaveLength(2);
    expect(notifications()).toEqual([
      "JAgentDesk tools are unavailable for Codex: the jagentdesk MCP server is failed: 401",
    ]);
    expect(userMessages()).toEqual(["one", "two"]);
  });

  test("an idle-released runtime resumes with a fresh JAgentDesk MCP config and is checked", async () => {
    const health: ToolHealthScript = { answers: [], checks: 0 };
    const { manager, client, agent, turn, registry } = await setup({ health, storage: true });
    await turn("one");
    const handle = manager.getAgent(agent.id)!.persistence!;
    let now = Date.now();
    const cleanup = createIdleRuntimeCleanup({
      enabled: true,
      runtimes: () => manager.getRuntimeCleanupCandidates(),
      logger,
      now: () => now,
      isProtected: () => false,
      schedule: () => () => {},
    });
    now += 2 * 60 * 60_000;
    const swept = await cleanup.sweep();
    cleanup.close();
    expect(swept.collected.map((entry) => entry.agentId)).toEqual([agent.id]);
    expect(manager.getAgent(agent.id)).toBeNull();

    // What agent-loading does when the next message arrives for a released runtime.
    await manager.resumeAgentFromPersistence(handle, undefined, agent.id);
    await turn("two");
    const resumed = client.resumed.at(-1)?.config?.mcpServers?.jagentdesk;
    expect(resumed?.type === "http" ? resumed.url : null).toBe(
      `http://127.0.0.1:1/mcp/agents?callerAgentId=${agent.id}`,
    );
    expect(health.checks).toBe(2);
    await registry?.flush();
  });

  test("a check that throws does not block the turn", async () => {
    const { manager, client, agent, turn, userMessages } = await setup();
    const session = manager.getAgent(agent.id)!.session as TurnSession;
    session.checkJAgentDeskTools = async () => {
      throw new Error("status timed out");
    };
    await turn("one");
    expect(client.resumed).toHaveLength(0);
    expect(userMessages()).toEqual(["one"]);
  });
});
