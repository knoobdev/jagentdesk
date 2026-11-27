import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
      subscribeBeforePublish: () => () => {},
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
            sources: [
              {
                id: "provider",
                kind: "provider",
                label: "",
                available: true,
                size: 14,
                modifiedAt: expect.any(String),
              },
            ],
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

// ADR-0064 / A4.27c.8: redirect files and the script, re-derived from the item's own command.
describe("background work extra sources", () => {
  const AGENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  let root: string;
  let current: Session | null = null;

  afterEach(async () => {
    await current?.cleanup();
    current = null;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function setup(input: { command: string; rows?: unknown[] }) {
    root = realpathSync(mkdtempSync(join(tmpdir(), "session-bg-sources-")));
    const cwd = join(root, "repo");
    mkdirSync(cwd);
    const store = new AgentBackgroundWorkStore();
    store.apply(
      AGENT,
      [
        {
          id: "b1",
          kind: "shell",
          description: null,
          command: input.command.replaceAll("$ROOT", root),
        },
      ],
      "2026-11-28T10:00:00.000Z",
    );
    const messages: SessionOutboundMessage[] = [];
    const session = createSessionForTest({
      messages,
      agentManager: {
        getAgent: vi.fn((id: string) =>
          id === AGENT ? { id, provider: "codex", cwd, internal: false } : null,
        ),
        getAgentBackgroundWorkDetail: vi.fn((agentId: string, itemId: string) =>
          store.detail(agentId, itemId),
        ),
        readAgentTimelineRows: vi.fn(async () => input.rows ?? []),
      },
    });
    current = session;
    return { session, messages, cwd, store };
  }

  async function detailOf(session: Session, messages: SessionOutboundMessage[]) {
    await session.handleMessage({
      type: "agent.background_work.get_detail.request",
      agentId: AGENT,
      itemId: "b1",
      requestId: `d${messages.length}`,
    });
    const reply = messages.at(-1);
    if (reply?.type !== "agent.background_work.get_detail.response") throw new Error("no reply");
    return reply.payload.detail;
  }

  test("a redirect file is its own source and streams as it grows", async () => {
    const { session, messages, cwd } = setup({
      command: 'sh -c "npm test > $ROOT/repo/t.log 2>&1"',
    });
    const before = await detailOf(session, messages);
    expect(before?.outputAvailable).toBe(false);
    expect(before?.sources).toEqual([
      { id: "provider", kind: "provider", label: "", available: false },
      {
        id: "redirect:0",
        kind: "redirect",
        label: "t.log",
        path: join(cwd, "t.log"),
        available: false,
        size: 0,
        modifiedAt: null,
      },
    ]);

    await session.handleMessage({
      type: "agent.background_work.output.subscribe.request",
      agentId: AGENT,
      itemId: "b1",
      subscriptionId: "s1",
      sourceId: "redirect:0",
      requestId: "r1",
    });
    expect(messages.at(-2)).toMatchObject({
      type: "agent.background_work.output.subscribe.response",
      payload: { error: null },
    });
    writeFileSync(join(cwd, "t.log"), "PASS a\n");
    await vi.waitFor(() =>
      expect(messages.at(-1)).toMatchObject({
        type: "agent.background_work.output",
        payload: { sourceId: "redirect:0", chunk: "PASS a\n", offset: 0 },
      }),
    );
    appendFileSync(join(cwd, "t.log"), "PASS b\n");
    await vi.waitFor(() =>
      expect(messages.at(-1)).toMatchObject({
        type: "agent.background_work.output",
        payload: { sourceId: "redirect:0", chunk: "PASS b\n", offset: 7 },
      }),
    );
    const after = await detailOf(session, messages);
    expect(after?.sources?.[1]).toMatchObject({ id: "redirect:0", available: true, size: 14 });
  });

  test("blocked targets get no source and cannot be subscribed", async () => {
    const { session, messages, cwd } = setup({
      command: "cmd > ~/.ssh/x 2> /dev/null > link.log > /etc/x.log",
    });
    // A symlink out of the allowed folders, to a file this test never reads.
    symlinkSync("/etc/hosts", join(cwd, "link.log"));
    const detail = await detailOf(session, messages);
    expect(detail?.sources).toEqual([
      { id: "provider", kind: "provider", label: "", available: false },
    ]);
    for (const sourceId of ["redirect:0", "redirect:1", "redirect:2", "redirect:3", "/etc/hosts"]) {
      await session.handleMessage({
        type: "agent.background_work.output.subscribe.request",
        agentId: AGENT,
        itemId: "b1",
        subscriptionId: `s-${sourceId}`,
        sourceId,
        requestId: `r-${sourceId}`,
      });
    }
    const errors = messages
      .filter((message) => message.type === "agent.background_work.output.subscribe.response")
      .map((message) => message.payload.error);
    expect(errors).toEqual([
      "Unknown output source",
      "Unknown output source",
      "Output file is outside the source's folders",
      "Unknown output source",
      "Unknown output source",
    ]);
    expect(messages.some((message) => message.type === "agent.background_work.output")).toBe(false);
  });

  test("the script and the agent's latest read of a redirect file", async () => {
    const { session, messages, cwd } = setup({
      command: "zsh $ROOT/repo/wait.sh > $ROOT/repo/w.log",
      rows: [
        {
          seq: 1,
          timestamp: "2026-11-28T10:05:00.000Z",
          item: {
            type: "tool_call",
            callId: "c1",
            name: "shell",
            status: "completed",
            error: null,
            detail: { type: "shell", command: "tail -n 20 w.log", output: "waiting 3/10" },
          },
        },
      ],
    });
    writeFileSync(join(cwd, "wait.sh"), "until [ -f done ]; do sleep 1; done\n");
    writeFileSync(join(cwd, "w.log"), "");
    const detail = await detailOf(session, messages);
    expect(detail?.sources?.slice(1)).toEqual([
      {
        id: "redirect:0",
        kind: "redirect",
        label: "w.log",
        path: join(cwd, "w.log"),
        available: true,
        size: 0,
        modifiedAt: expect.any(String),
        lastRead: { at: "2026-11-28T10:05:00.000Z", content: "waiting 3/10", truncated: false },
      },
      {
        id: "script",
        kind: "script",
        label: "wait.sh",
        path: join(cwd, "wait.sh"),
        available: true,
        script: {
          content: "until [ -f done ]; do sleep 1; done\n",
          truncated: false,
          lineCount: 1,
        },
      },
    ]);
  });
});
