import { describe, expect, test } from "vitest";
import type { V2Api } from "./api.js";
import { attachMcpServers } from "./mcp-attach.js";

interface FakeClient {
  mcp: {
    add: (input: { server: string }) => Promise<void>;
    list: (
      input?: unknown,
    ) => Promise<{ data: Array<{ name: string; status: { status: string; error?: string } }> }>;
  };
  session: {
    context: (input: { sessionID: string }) => Promise<unknown>;
  };
}

const asClient = (fake: FakeClient): Pick<V2Api, "mcp" | "session"> =>
  fake as unknown as Pick<V2Api, "mcp" | "session">;

const connectedCatalog = (names: string[]) => ({
  data: names.map((name) => ({ name, status: { status: "connected" } })),
});

const toolCallMessage = (name: string) => [
  {
    id: "msg_1",
    type: "assistant",
    content: [{ type: "tool", name, state: { status: "completed" } }],
  },
];

function createLogger() {
  const warnings: Array<{ obj: unknown; message: string }> = [];
  return {
    warnings,
    warn: (obj: unknown, message: string) => {
      warnings.push({ obj, message });
    },
  };
}

describe("OpenCode v2 MCP attach", () => {
  test("adds each injected server, waits for its tools in the session context, then moves on", async () => {
    const added: string[] = [];
    let contextPolls = 0;
    const logger = createLogger();
    await attachMcpServers({
      client: asClient({
        mcp: {
          add: async (input) => {
            added.push(input.server);
          },
          list: async () => connectedCatalog(["jagentdesk"]),
        },
        session: {
          context: async () => {
            contextPolls += 1;
            return contextPolls < 3 ? [] : toolCallMessage("jagentdesk_ssh_run");
          },
        },
      }),
      sessionID: "ses_1",
      location: { directory: "/tmp/ws" },
      mcpServers: { jagentdesk: { type: "http", url: "http://127.0.0.1:1/mcp" } },
      logger,
    });
    expect(added).toEqual(["jagentdesk"]);
    expect(contextPolls).toBeGreaterThanOrEqual(3);
    expect(logger.warnings).toEqual([]);
  });

  test("keeps waiting while the context stays empty, then resolves once a tool appears", async () => {
    let contextPolls = 0;
    const logger = createLogger();
    await attachMcpServers({
      client: asClient({
        mcp: {
          add: async () => undefined,
          list: async () => connectedCatalog(["jagentdesk"]),
        },
        session: {
          context: async () => {
            contextPolls += 1;
            return contextPolls < 4 ? [] : toolCallMessage("jagentdesk_remote_run");
          },
        },
      }),
      sessionID: "ses_1",
      location: { directory: "/tmp/ws" },
      mcpServers: { jagentdesk: { type: "http", url: "http://127.0.0.1:1/mcp" } },
      toolWaitTimeoutMs: 5_000,
      logger,
    });
    expect(contextPolls).toBe(4);
  });

  test("matches tool names per server and does not cross-match other servers", async () => {
    const logger = createLogger();
    await attachMcpServers({
      client: asClient({
        mcp: {
          add: async () => undefined,
          list: async () => connectedCatalog(["jagentdesk", "other"]),
        },
        session: {
          context: async () => toolCallMessage("jagentdesk_ssh_run"),
        },
      }),
      sessionID: "ses_1",
      location: { directory: "/tmp/ws" },
      mcpServers: {
        jagentdesk: { type: "http", url: "http://127.0.0.1:1/mcp" },
        other: { type: "http", url: "http://127.0.0.1:2/mcp" },
      },
      toolWaitTimeoutMs: 120,
      logger,
    });
    expect(logger.warnings).toEqual([
      { obj: { server: "other", sessionID: "ses_1" }, message: expect.any(String) },
    ]);
  });

  test("accepts a tool name surfaced inside message text", async () => {
    const logger = createLogger();
    await attachMcpServers({
      client: asClient({
        mcp: {
          add: async () => undefined,
          list: async () => connectedCatalog(["jagentdesk"]),
        },
        session: {
          context: async () => [
            {
              id: "msg_1",
              type: "user",
              text: 'catalog now includes "jagentdesk_ssh_run" and more',
            },
          ],
        },
      }),
      sessionID: "ses_1",
      location: { directory: "/tmp/ws" },
      mcpServers: { jagentdesk: { type: "http", url: "http://127.0.0.1:1/mcp" } },
      logger,
    });
    expect(logger.warnings).toEqual([]);
  });

  test("warns and continues when the tools never appear", async () => {
    const added: string[] = [];
    const logger = createLogger();
    await attachMcpServers({
      client: asClient({
        mcp: {
          add: async (input) => {
            added.push(input.server);
          },
          list: async () => connectedCatalog(["jagentdesk", "second"]),
        },
        session: { context: async () => [] },
      }),
      sessionID: "ses_1",
      location: { directory: "/tmp/ws" },
      mcpServers: {
        jagentdesk: { type: "http", url: "http://127.0.0.1:1/mcp" },
        second: { type: "http", url: "http://127.0.0.1:2/mcp" },
      },
      toolWaitTimeoutMs: 30,
      logger,
    });
    expect(added).toEqual(["jagentdesk", "second"]);
    expect(logger.warnings).toHaveLength(2);
    expect(logger.warnings.map((w) => (w.obj as { server: string }).server)).toEqual([
      "jagentdesk",
      "second",
    ]);
  });

  test("stops waiting when the session aborts", async () => {
    const controller = new AbortController();
    const logger = createLogger();
    const pending = attachMcpServers({
      client: asClient({
        mcp: {
          add: async () => undefined,
          list: async () => connectedCatalog(["jagentdesk"]),
        },
        session: { context: async () => [] },
      }),
      sessionID: "ses_1",
      location: { directory: "/tmp/ws" },
      mcpServers: { jagentdesk: { type: "http", url: "http://127.0.0.1:1/mcp" } },
      signal: controller.signal,
      logger,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(logger.warnings).toEqual([]);
  });

  test("fails the attach when a server reports a failed connection", async () => {
    const logger = createLogger();
    await expect(
      attachMcpServers({
        client: asClient({
          mcp: {
            add: async () => undefined,
            list: async () => ({
              data: [{ name: "jagentdesk", status: { status: "failed", error: "boom" } }],
            }),
          },
          session: { context: async () => [] },
        }),
        sessionID: "ses_1",
        location: { directory: "/tmp/ws" },
        mcpServers: { jagentdesk: { type: "http", url: "http://127.0.0.1:1/mcp" } },
        logger,
      }),
    ).rejects.toThrow("OpenCode MCP server jagentdesk failed to connect: boom");
    expect(logger.warnings).toEqual([]);
  });

  test("maps stdio configs to local OpenCode MCP configs with codemode disabled", async () => {
    const configs: unknown[] = [];
    const logger = createLogger();
    await attachMcpServers({
      client: asClient({
        mcp: {
          add: async (input) => {
            configs.push((input as { config: unknown }).config);
          },
          list: async () => connectedCatalog(["tools"]),
        },
        session: { context: async () => toolCallMessage("tools_probe") },
      }),
      sessionID: "ses_1",
      location: { directory: "/tmp/ws" },
      mcpServers: {
        tools: { type: "stdio", command: "node", args: ["server.mjs"], env: { FOO: "bar" } },
      },
      logger,
    });
    expect(configs).toEqual([
      {
        type: "local",
        command: ["node", "server.mjs"],
        environment: { FOO: "bar" },
        codemode: false,
      },
    ]);
  });
});
