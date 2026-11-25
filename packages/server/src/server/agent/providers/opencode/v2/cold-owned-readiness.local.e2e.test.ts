import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { expect, test, vi } from "vitest";
import { z } from "zod";
import { createTestLogger } from "../../../../../test-utils/test-logger.js";
import { createAgentMcpProtocolNormalizer } from "../../../mcp-protocol.js";
import { buildOpenCodeProviderConfig } from "../../../../custom-providers/materialization.js";
import { OpenCodeV2AgentClient } from "./agent.js";
import type { AgentSession } from "../../../agent-sdk-types.js";

test("a fresh real owned OpenCode server sends the injected MCP tools on its first custom API request", async ({
  onTestFinished,
}) => {
  const root = await mkdtemp(path.join(tmpdir(), "jagentdesk-cold-opencode-"));
  vi.stubEnv("JAGENTDESK_HOME", path.join(root, "jagentdesk"));
  let receive!: (body: unknown) => void;
  const firstRequest = new Promise<unknown>((resolve) => {
    receive = resolve;
  });
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  const logger = createTestLogger();
  const normalize = createAgentMcpProtocolNormalizer(logger);
  const transports = new Set<StreamableHTTPServerTransport>();
  async function handleMcp(request: express.Request, response: express.Response) {
    const mcp = new McpServer({ name: "cold-readiness", version: "1.0.0" });
    mcp.registerTool("probe", { description: "Report readiness", inputSchema: {} }, async () => ({
      content: [{ type: "text", text: "ready" }],
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    transports.add(transport);
    response.once("close", () => {
      transports.delete(transport);
      void mcp.close();
    });
    normalize({ request, transport, callerAgentId: "cold-owned" });
    await mcp.connect(transport);
    await transport.handleRequest(request, response, request.body);
  }
  app.post("/mcp", (request, response) => {
    void handleMcp(request, response).catch((error: unknown) => {
      response.status(500).json({ error: String(error) });
    });
  });
  app.post("/v1/chat/completions", (request, response) => {
    receive(request.body);
    // A terminal provider response keeps this local test independent of models,
    // credentials, and retries while retaining the real OpenCode request path.
    response
      .status(400)
      .json({ error: { message: "Probe complete", type: "invalid_request_error" } });
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Probe did not listen");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const client = new OpenCodeV2AgentClient({
    logger,
    selection: { kind: "explicit", server: { url: "http://127.0.0.1:1" } },
    settings: {
      env: {
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_STATE_HOME: path.join(root, "state"),
        OPENCODE_CONFIG_CONTENT: "{}",
      },
    },
    providerConfigInjection: async () => ({
      id: "local",
      config: buildOpenCodeProviderConfig(
        { label: "Local", protocol: "openai", models: [{ id: "m1", label: "M1" }] },
        { baseUrl: `${baseUrl}/v1`, apiKey: null },
      ),
    }),
  });
  let session: AgentSession | undefined;
  onTestFinished(async () => {
    await session?.close();
    await client.shutdown();
    await Promise.all([...transports].map((transport) => transport.close()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  session = await client.createSession({
    provider: "opencode",
    cwd: root,
    model: "local/m1",
    title: "Cold MCP regression",
    mcpServers: { jagentdesk: { type: "http", url: `${baseUrl}/mcp` } },
  });
  await session.startTurn("hi");
  const body = z
    .object({
      model: z.literal("m1"),
      tools: z.array(z.object({ function: z.object({ name: z.string() }) })),
    })
    .parse(await firstRequest);
  expect(body.tools.map((tool) => tool.function.name)).toContain("jagentdesk_probe");
}, 30_000);
