import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AgentBackgroundWorkStore } from "./agent/background-work/index.js";
import type { SessionInboundMessage, SessionOutboundMessage } from "./messages.js";
import { Session, type SessionOptions } from "./session.js";
import { createStub } from "./test-utils/class-mocks.js";
import { createProviderSnapshotManagerStub } from "./test-utils/session-stubs.js";
import { createWorkspaceRuntimeStore } from "./workspace-runtime-store/index.js";

function createSessionForTest(options: {
  messages: SessionOutboundMessage[];
  agentManager: Record<string, unknown>;
}): Session {
  return new Session({
    workspaceRuntimeStore: createWorkspaceRuntimeStore(),
    clientId: "test-client",
    scopes: ["*"],
    onMessage: (message) => options.messages.push(message),
    logger: pino({ level: "silent" }),
    downloadTokenStore: createStub<SessionOptions["downloadTokenStore"]>({}),
    pushNotifications: createStub<SessionOptions["pushNotifications"]>({}),
    jagentdeskHome: "/tmp/jagentdesk-test",
    agentManager: createStub<SessionOptions["agentManager"]>({
      subscribe: () => () => {},
      listAgents: () => [],
      listProviderSubagentActivity: () => [],
      getAgentBackgroundWorkSummary: () => undefined,
      ...options.agentManager,
    }),
    agentStorage: createStub<SessionOptions["agentStorage"]>({
      list: async () => [],
      get: async () => null,
    }),
    projectRegistry: createStub<SessionOptions["projectRegistry"]>({
      subscribeToMutations: () => () => {},
      initialize: async () => {},
      existsOnDisk: async () => true,
      list: async () => [],
      get: async () => null,
    }),
    workspaceRegistry: createStub<SessionOptions["workspaceRegistry"]>({
      subscribeToMutations: () => () => {},
      initialize: async () => {},
      existsOnDisk: async () => true,
      list: async () => [],
      get: async () => null,
    }),
    checkoutDiffManager: createStub<SessionOptions["checkoutDiffManager"]>({
      scheduleRefreshForCwd: () => {},
      dispose: () => {},
    }),
    workspaceGitService: createStub<SessionOptions["workspaceGitService"]>({}),
    daemonConfigStore: createStub<NonNullable<SessionOptions["daemonConfigStore"]>>({
      get: () => ({ mcp: { injectIntoAgents: false }, providers: {} }),
      onChange: () => () => {},
    }),
    mcpBaseUrl: null,
    stt: null,
    tts: null,
    providerSnapshotManager: createProviderSnapshotManagerStub().manager,
    terminalManager: null,
  });
}

// ADR-0062 §3 / A4.27c.6: detail and output only for the requesting agent's own work, read
// only from the source its provider attached; never by a path the client sends.
describe("background work detail and output", () => {
  const AGENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const AGENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  let root: string;
  let current: Session | null = null;

  afterEach(async () => {
    await current?.cleanup();
    current = null;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  async function setup() {
    root = mkdtempSync(join(tmpdir(), "session-bg-output-"));
    const path = join(root, "b1.output");
    writeFileSync(path, "line-1\nline-2\n");
    const store = new AgentBackgroundWorkStore();
    store.apply(AGENT_A, [
      {
        id: "b1",
        kind: "shell",
        description: "count",
        command: "for i in 1 2; do echo line-$i; done",
        cwd: "/repo/sub",
        output: { type: "file", locate: async () => ({ path, roots: [root] }) },
      },
      { id: "b2", kind: "other", description: "no output" },
    ]);
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({
      messages,
      agentManager: {
        getAgent: vi.fn((id: string) =>
          id === AGENT_A || id === AGENT_B
            ? { id, provider: "claude", cwd: "/repo", internal: false }
            : null,
        ),
        getAgentBackgroundWorkDetail: vi.fn((agentId: string, itemId: string) =>
          store.detail(agentId, itemId),
        ),
      },
    });
    current = session;
    return { session, messages, path };
  }

  function outputPushes(messages: SessionOutboundMessage[]) {
    return messages.filter((message) => message.type === "agent.background_work.output");
  }

  test("returns the agent's own item with its folder and output availability", async () => {
    const { session, messages } = await setup();
    await session.handleMessage({
      type: "agent.background_work.get_detail.request",
      agentId: AGENT_A,
      itemId: "b1",
      requestId: "d1",
    });
    await session.handleMessage({
      type: "agent.background_work.get_detail.request",
      agentId: AGENT_A,
      itemId: "b2",
      requestId: "d2",
    });
    expect(messages).toEqual([
      {
        type: "agent.background_work.get_detail.response",
        payload: {
          requestId: "d1",
          agentId: AGENT_A,
          itemId: "b1",
          detail: {
            id: "b1",
            kind: "shell",
            description: "count",
            command: "for i in 1 2; do echo line-$i; done",
            startedAt: expect.any(String),
            status: "running",
            endedAt: null,
            exitCode: null,
            cwd: "/repo/sub",
            provider: "claude",
            outputAvailable: true,
          },
          error: null,
        },
      },
      {
        type: "agent.background_work.get_detail.response",
        payload: expect.objectContaining({
          requestId: "d2",
          detail: expect.objectContaining({ outputAvailable: false, cwd: "/repo" }),
        }),
      },
    ]);
  });

  test("refuses another agent's item and never reads a client-sent path", async () => {
    const { session, messages } = await setup();
    await session.handleMessage({
      type: "agent.background_work.get_detail.request",
      agentId: AGENT_B,
      itemId: "b1",
      requestId: "d1",
    });
    await session.handleMessage({
      type: "agent.background_work.output.subscribe.request",
      agentId: AGENT_B,
      itemId: "b1",
      subscriptionId: "s1",
      requestId: "r1",
    });
    await session.handleMessage({
      type: "agent.background_work.output.subscribe.request",
      agentId: AGENT_A,
      itemId: "/etc/passwd",
      subscriptionId: "s2",
      requestId: "r2",
      path: "/etc/passwd",
    } as SessionInboundMessage);
    await session.handleMessage({
      type: "agent.background_work.output.subscribe.request",
      agentId: AGENT_A,
      itemId: "b2",
      subscriptionId: "s3",
      requestId: "r3",
    });

    expect(messages).toEqual([
      {
        type: "agent.background_work.get_detail.response",
        payload: {
          requestId: "d1",
          agentId: AGENT_B,
          itemId: "b1",
          detail: null,
          error: "Background work not found",
        },
      },
      {
        type: "agent.background_work.output.subscribe.response",
        payload: {
          requestId: "r1",
          subscriptionId: "s1",
          agentId: AGENT_B,
          itemId: "b1",
          error: "Background work not found",
        },
      },
      {
        type: "agent.background_work.output.subscribe.response",
        payload: expect.objectContaining({ requestId: "r2", error: "Background work not found" }),
      },
      {
        type: "agent.background_work.output.subscribe.response",
        payload: expect.objectContaining({
          requestId: "r3",
          error: "Output isn't available for this background task",
        }),
      },
    ]);
    expect(outputPushes(messages)).toEqual([]);
  });

  test("streams the tail after the response and stops on unsubscribe", async () => {
    const { session, messages, path } = await setup();
    await session.handleMessage({
      type: "agent.background_work.output.subscribe.request",
      agentId: AGENT_A,
      itemId: "b1",
      subscriptionId: "s1",
      requestId: "r1",
    });
    expect(messages.map((message) => message.type)).toEqual([
      "agent.background_work.output.subscribe.response",
      "agent.background_work.output",
    ]);
    expect(messages[1]).toEqual({
      type: "agent.background_work.output",
      payload: {
        subscriptionId: "s1",
        agentId: AGENT_A,
        itemId: "b1",
        chunk: "line-1\nline-2\n",
        offset: 0,
        nextOffset: 14,
        reset: true,
      },
    });

    appendFileSync(path, "line-3\n");
    await vi.waitFor(() =>
      expect(outputPushes(messages).at(-1)).toMatchObject({
        payload: { chunk: "line-3\n", offset: 14 },
      }),
    );

    await session.handleMessage({
      type: "agent.background_work.output.unsubscribe.request",
      subscriptionId: "s1",
      requestId: "u1",
    });
    const count = outputPushes(messages).length;
    appendFileSync(path, "line-4\n");
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(outputPushes(messages)).toHaveLength(count);
  });
});
