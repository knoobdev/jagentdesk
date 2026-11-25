import {
  InitializeResultSchema,
  JSONRPCResponseSchema,
  LATEST_PROTOCOL_VERSION,
  ListToolsResultSchema,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createTestJAgentDeskDaemon,
  type TestJAgentDeskDaemon,
} from "../test-utils/jagentdesk-daemon.js";

async function readMcpResult(response: Response) {
  const body = await response.text();
  expect(response.status, body).toBe(200);
  const data = body.match(/^data: (.+)$/m);
  expect(data, body).not.toBeNull();
  return JSONRPCResponseSchema.parse(JSON.parse(data![1]!)).result;
}

describe("Agent MCP protocol version headers", () => {
  let daemon: TestJAgentDeskDaemon;
  const logs: string[] = [];

  beforeAll(async () => {
    daemon = await createTestJAgentDeskDaemon({
      logger: pino({ level: "info" }, { write: (message) => logs.push(message) }),
    });
  });

  afterAll(async () => {
    await daemon?.close();
  });

  function post(options: {
    method: string;
    headers?: Record<string, string>;
    query?: string;
    params?: unknown;
  }) {
    return fetch(`http://127.0.0.1:${daemon.port}/mcp/agents${options.query ?? ""}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...options.headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: options.method,
        params: options.params,
      }),
    });
  }

  test.each(["session", "caller"])(
    "uses the initialize result for a newer header and logs once per %s",
    async (identity) => {
      const negotiatedVersion = "2025-06-18";
      const headers: Record<string, string> = {};
      const query = identity === "caller" ? "?callerAgentId=protocol-test-agent" : "";
      if (identity === "session") {
        headers["mcp-session-id"] = "protocol-test-session";
      }
      const initialized = await post({
        method: "initialize",
        headers,
        query,
        params: {
          protocolVersion: negotiatedVersion,
          capabilities: {},
          clientInfo: { name: "protocol-regression", version: "1.0.0" },
        },
      });
      expect(initialized.headers.get("mcp-session-id")).toBeNull();
      expect(InitializeResultSchema.parse(await readMcpResult(initialized)).protocolVersion).toBe(
        negotiatedVersion,
      );

      const logStart = logs.length;
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await post({
          method: "tools/list",
          headers: { ...headers, "mcp-protocol-version": "2026-07-28" },
          query,
        });
        const result = ListToolsResultSchema.parse(await readMcpResult(response));
        expect(result.tools.map((tool) => tool.name)).toContain("list_agents");
      }
      const normalizationLogs = logs.slice(logStart).filter((line) => line.includes("2026-07-28"));
      expect(normalizationLogs).toHaveLength(1);
      expect(JSON.parse(normalizationLogs[0]!)).toMatchObject({
        level: 30,
        originalProtocolVersion: "2026-07-28",
        protocolVersion: negotiatedVersion,
      });
    },
  );

  test.each(["unknown-session", undefined])(
    "uses the latest version for %s without negotiation",
    async (sessionId) => {
      const logStart = logs.length;
      const headers: Record<string, string> = { "mcp-protocol-version": "2026-07-28" };
      if (sessionId) {
        headers["mcp-session-id"] = sessionId;
      }
      const response = await post({
        method: "tools/list",
        headers,
      });
      expect(
        ListToolsResultSchema.parse(await readMcpResult(response)).tools.length,
      ).toBeGreaterThan(0);
      const normalizationLogs = logs.slice(logStart).filter((line) => line.includes("2026-07-28"));
      expect(normalizationLogs).toHaveLength(1);
      expect(JSON.parse(normalizationLogs[0]!)).toMatchObject({
        protocolVersion: LATEST_PROTOCOL_VERSION,
      });
    },
  );

  test("normalizes an unsupported initialize header and records the actual result", async () => {
    const headers = {
      "mcp-session-id": "newer-initialize-session",
      "MCP-Protocol-Version": "2026-07-28",
    };
    const initialized = await post({
      method: "initialize",
      headers,
      params: {
        protocolVersion: "2026-07-28",
        capabilities: {},
        clientInfo: { name: "newer-client", version: "1.0.0" },
      },
    });
    expect(InitializeResultSchema.parse(await readMcpResult(initialized)).protocolVersion).toBe(
      LATEST_PROTOCOL_VERSION,
    );
    const logStart = logs.length;
    const response = await post({ method: "tools/list", headers });
    expect(ListToolsResultSchema.parse(await readMcpResult(response)).tools.length).toBeGreaterThan(
      0,
    );
    expect(logs.slice(logStart).filter((line) => line.includes("originalProtocolVersion"))).toEqual(
      [],
    );
  });

  test("accepts supported and absent headers without normalization", async () => {
    const logStart = logs.length;
    for (const protocolVersion of [...SUPPORTED_PROTOCOL_VERSIONS, undefined]) {
      const headers: Record<string, string> = {};
      if (protocolVersion) {
        headers["mcp-protocol-version"] = protocolVersion;
      }
      const response = await post({ method: "tools/list", headers });
      expect(
        ListToolsResultSchema.parse(await readMcpResult(response)).tools.length,
      ).toBeGreaterThan(0);
    }
    expect(logs.slice(logStart).filter((line) => line.includes("originalProtocolVersion"))).toEqual(
      [],
    );
  });
});
