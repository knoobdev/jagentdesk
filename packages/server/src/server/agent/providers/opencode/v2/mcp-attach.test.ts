import { describe, expect, test } from "vitest";
import type { McpServerConfig } from "../../../agent-sdk-types.js";
import type { V2Api } from "./api.js";
import { attachMcpServers } from "./mcp-attach.js";

type McpClient = Pick<V2Api, "mcp">;
const location = { directory: "/tmp/ws" };
const servers: Record<string, McpServerConfig> = {
  jagentdesk: { type: "http", url: "http://127.0.0.1:1/mcp" },
};

function adapter(input: {
  add?: McpClient["mcp"]["add"];
  list: McpClient["mcp"]["list"];
}): McpClient {
  return { mcp: { add: input.add ?? (async () => undefined), list: input.list } };
}

function catalog(names: string[]) {
  return {
    location,
    data: names.map((name) => ({ name, status: { status: "connected" as const } })),
  };
}

describe("OpenCode v2 MCP attach", () => {
  test("waits for each server's catalog connection without reading session history", async () => {
    const added: string[] = [];
    const reads: string[] = [];
    let pending = true;
    const client = adapter({
      add: async ({ server }) => {
        added.push(server);
        pending = true;
      },
      list: async () => {
        const server = added.at(-1)!;
        reads.push(server);
        if (pending) {
          pending = false;
          return { location, data: [{ name: server, status: { status: "pending" } }] };
        }
        return catalog([server]);
      },
    });
    await attachMcpServers({
      client,
      location,
      mcpServers: { ...servers, other: servers.jagentdesk! },
    });
    expect(added).toEqual(["jagentdesk", "other"]);
    expect(reads).toEqual(["jagentdesk", "jagentdesk", "other", "other"]);
  });

  test.each([
    { status: "failed" as const, error: "boom", reason: "boom" },
    { status: "disabled" as const, reason: "disabled" },
    { status: "needs_auth" as const, error: "Sign in", reason: "needs_auth" },
  ])("fails when the injected server is $status", async ({ reason, ...status }) => {
    const client = adapter({
      list: async () => ({ location, data: [{ name: "jagentdesk", status }] }),
    });
    await expect(attachMcpServers({ client, location, mcpServers: servers })).rejects.toThrow(
      `OpenCode MCP server jagentdesk failed to connect: ${reason}`,
    );
  });

  test.each(["add", "list"] as const)(
    "aborts a stalled %s even when the adapter ignores the signal",
    async (operation) => {
      const controller = new AbortController();
      const stalled = () => {
        queueMicrotask(() => controller.abort(new Error("Session closed")));
        return new Promise<never>(() => undefined);
      };
      const client = adapter({
        add: operation === "add" ? stalled : async () => undefined,
        list: operation === "list" ? stalled : async () => catalog(["jagentdesk"]),
      });
      await expect(
        attachMcpServers({ client, location, mcpServers: servers, signal: controller.signal }),
      ).rejects.toThrow("Session closed");
    },
  );

  test("maps HTTP and stdio configuration with codemode disabled", async () => {
    const configs: unknown[] = [];
    const client = adapter({
      add: async (input) => {
        configs.push(input);
      },
      list: async () => catalog(["jagentdesk", "tools"]),
    });
    await attachMcpServers({
      client,
      location,
      mcpServers: {
        ...servers,
        tools: { type: "stdio", command: "node", args: ["server.mjs"], env: { FOO: "bar" } },
      },
    });
    expect(configs).toEqual([
      {
        server: "jagentdesk",
        location,
        config: { type: "remote", url: "http://127.0.0.1:1/mcp", oauth: false, codemode: false },
      },
      {
        server: "tools",
        location,
        config: {
          type: "local",
          command: ["node", "server.mjs"],
          environment: { FOO: "bar" },
          codemode: false,
        },
      },
    ]);
  });
});
