import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { createTestLogger } from "../../../../../test-utils/test-logger.js";
import { OpenCodeBridge } from "../bridge.js";
import { provisionLocalBridge } from "./bridge-provisioning.js";
import { selectOpenCodeService, type OpenCodeServiceSelection } from "./service-selection.js";
import { V2Runtime, type V2RuntimeAcquireOptions } from "./runtime.js";
import { requiresDedicatedV2Server } from "./configuration.js";
import { attachMcpServers } from "./mcp-attach.js";
import type { AgentSessionConfig } from "../../../agent-sdk-types.js";

test.each([
  { name: "dedicated session", input: { dedicated: true }, expectedMarker: null },
  {
    name: "launch environment",
    input: { env: { JAGENTDESK_TEST_ISOLATION: "isolated" } },
    expectedMarker: "isolated",
  },
] satisfies Array<{ name: string; input: V2RuntimeAcquireOptions; expectedMarker: string | null }>)(
  "starts an owned server for a $name despite an explicit shared service",
  async ({ input, expectedMarker }) => {
    const root = await mkdtemp(path.join(tmpdir(), "jagentdesk-opencode-explicit-isolation-"));
    const script = path.join(root, "server.cjs");
    const record = path.join(root, "env.json");
    await writeFile(
      script,
      `
      const http = require('node:http');
      require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({
        pid: process.pid, marker: process.env.JAGENTDESK_TEST_ISOLATION ?? null,
      }));
      const server = http.createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ version: '2.0.10', pid: process.pid, urls: [], paths: { tmp: '/tmp' } }));
      });
      server.listen(0, '127.0.0.1', () => console.log('server listening on http://127.0.0.1:' + server.address().port));
    `,
    );
    const runtime = new V2Runtime({
      logger: createTestLogger(),
      externalServer: { url: "http://127.0.0.1:1" },
      settings: { command: { mode: "replace", argv: [process.execPath, script] } },
    });
    try {
      const connection = await runtime.acquire(input);
      const info = await connection.client.server.info();
      expect(info.pid).not.toBe(process.pid);
      expect(JSON.parse(await readFile(record, "utf8"))).toEqual({
        pid: info.pid,
        marker: expectedMarker,
      });
      const exited = connection.exited;
      await connection.release();
      await expect(exited).resolves.toBeInstanceOf(Error);
    } finally {
      await runtime.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);

test("uses an owned server for MCP servers while a shared service is discoverable and already leased", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jagentdesk-opencode-isolation-"));
  const script = path.join(root, "server.cjs");
  const record = path.join(root, "requests.jsonl");
  const sharedRequests: string[] = [];
  const shared = createServer((request, response) => {
    sharedRequests.push(`${request.method} ${request.url}`);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ version: "2.0.10", pid: process.pid, urls: [], paths: { tmp: root } }),
    );
  });
  await new Promise<void>((resolve) => shared.listen(0, "127.0.0.1", resolve));
  const address = shared.address();
  if (!address || typeof address === "string") throw new Error("No shared service address");
  const url = `http://127.0.0.1:${address.port}`;
  await mkdir(path.join(root, "opencode"));
  await writeFile(
    path.join(root, "opencode", "service.json"),
    JSON.stringify({ url, pid: process.pid, version: "2.0.10" }),
  );
  await writeFile(
    script,
    `
      const http = require('node:http');
      const fs = require('node:fs');
      const location = { directory: ${JSON.stringify(root)} };
      const server = http.createServer(async (request, response) => {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString();
        const pathname = new URL(request.url, 'http://localhost').pathname;
        fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({
          method: request.method, pathname, body: body ? JSON.parse(body) : null,
        }) + '\\n');
        if (request.method === 'PUT') {
          response.writeHead(204).end();
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        if (pathname === '/api/info')
          response.end(JSON.stringify({ version: '2.0.10', pid: process.pid, urls: [], paths: { tmp: '/tmp' } }));
        else if (pathname === '/api/mcp' && request.method === 'GET')
          response.end(JSON.stringify({ location, data: [{ name: 'jagentdesk', status: { status: 'connected' } }] }));
        else if (pathname.endsWith('/context'))
          response.end(JSON.stringify({ data: [{ content: [{ name: 'jagentdesk_list_agents' }] }] }));
        else response.end(JSON.stringify({}));
      });
      server.listen(0, '127.0.0.1', () => console.log('server listening on http://127.0.0.1:' + server.address().port));
      `,
  );
  const settings = {
    command: { mode: "replace" as const, argv: [process.execPath, script] },
    env: { XDG_STATE_HOME: root },
  };
  const runtime = new V2Runtime({ logger: createTestLogger(), settings });
  try {
    expect(await selectOpenCodeService({ env: settings.env })).toEqual({
      kind: "discovered",
      server: { url },
    });
    const sharedConnection = await runtime.acquire();
    expect((await sharedConnection.client.server.info()).pid).toBe(process.pid);
    const sharedReads = sharedRequests.length;
    const config: AgentSessionConfig = {
      provider: "opencode",
      cwd: root,
      mcpServers: { jagentdesk: { type: "http", url: `${url}/mcp` } },
    };
    expect(requiresDedicatedV2Server(config)).toBe(true);
    const connection = await runtime.acquire({
      dedicated: requiresDedicatedV2Server(config),
    });
    expect((await connection.client.server.info()).pid).not.toBe(process.pid);
    await attachMcpServers({
      client: connection.client,
      location: { directory: root },
      mcpServers: config.mcpServers,
    });
    const requests = (await readFile(record, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(requests).toEqual([
      { method: "GET", pathname: "/api/info", body: null },
      { method: "GET", pathname: "/api/info", body: null },
      {
        method: "PUT",
        pathname: "/api/experimental/mcp/jagentdesk",
        body: { config: { type: "remote", url: `${url}/mcp`, oauth: false, codemode: false } },
      },
      { method: "GET", pathname: "/api/mcp", body: null },
    ]);
    expect(sharedRequests).toHaveLength(sharedReads);
    expect(sharedRequests.every((request) => request === "GET /api/info")).toBe(true);
    await connection.release();
    const reused = await runtime.acquire();
    expect(reused.client).toBe(sharedConnection.client);
    expect((await reused.client.server.info()).pid).toBe(process.pid);
    await reused.release();
    await sharedConnection.release();
  } finally {
    await runtime.shutdown();
    shared.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      shared.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test.each([
  {
    name: "provider environment despite an explicit selection",
    selection: {
      kind: "explicit",
      server: { url: "http://127.0.0.1:1" },
    } as OpenCodeServiceSelection,
    providerConfigInjection: undefined,
    expectedConfig: {},
  },
  {
    name: "provider environment despite a discovered selection",
    selection: {
      kind: "discovered",
      server: { url: "http://127.0.0.1:1" },
    } as OpenCodeServiceSelection,
    providerConfigInjection: undefined,
    expectedConfig: {},
  },
  {
    name: "plain",
    selection: { kind: "owned" } as OpenCodeServiceSelection,
    providerConfigInjection: undefined,
    expectedConfig: {},
  },
  {
    name: "custom API despite an external selection",
    selection: {
      kind: "explicit",
      server: { url: "http://127.0.0.1:1" },
    } as OpenCodeServiceSelection,
    providerConfigInjection: async () => ({ id: "local", config: { name: "Local model server" } }),
    expectedConfig: { provider: { local: { name: "Local model server" } } },
  },
])(
  "an owned $name helper uses an installed bridge once and survives catalog refresh",
  async ({ selection, providerConfigInjection, expectedConfig }) => {
    const root = await mkdtemp(path.join(tmpdir(), "jagentdesk-owned-opencode-"));
    const config = path.join(root, "config", "opencode");
    const script = path.join(root, "server.cjs");
    const record = path.join(root, "env.json");
    const bridge = new OpenCodeBridge({ jagentdeskHome: root, logger: createTestLogger() });
    await bridge.start();
    const artifact = fileURLToPath(await bridge.materializeV2Plugin());
    await provisionLocalBridge({
      configDirectory: config,
      artifact: path.join(artifact, "server.js"),
    });
    await writeFile(
      script,
      `
    const http = require('node:http');
    require('node:fs').writeFileSync(${JSON.stringify(record)}, process.env.OPENCODE_CONFIG_CONTENT);
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ version: '2.0.10', pid: process.pid, urls: [], paths: { tmp: '/tmp' } }));
    });
    server.listen(0, '127.0.0.1', () => console.log('server listening on http://127.0.0.1:' + server.address().port));
  `,
    );
    const runtime = new V2Runtime({
      logger: createTestLogger(),
      bridge,
      selection,
      providerConfigInjection,
      settings: {
        command: { mode: "replace", argv: [process.execPath, script] },
        env: { XDG_CONFIG_HOME: path.join(root, "config"), OPENCODE_CONFIG_CONTENT: "{}" },
      },
    });
    try {
      const first = await runtime.acquire();
      const pid = (await first.client.server.info()).pid;
      expect(JSON.parse(await readFile(record, "utf8"))).toEqual(expectedConfig);
      await first.release();
      const refreshed = await runtime.acquire({ fresh: true });
      expect((await refreshed.client.server.info()).pid).toBe(pid);
      await refreshed.release();
    } finally {
      await runtime.shutdown();
      await bridge.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);

test("reports a bridge port change that has not been applied", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jagentdesk-opencode-port-"));
  const bridge = new OpenCodeBridge({ jagentdeskHome: root, logger: createTestLogger() });
  await bridge.start();
  const actual = Number(new URL(bridge.sharedV2Connection().baseUrl).port);
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    bridge,
    selection: { kind: "explicit", server: { url: "http://127.0.0.1:1" } },
    settings: { env: { JAGENTDESK_OPENCODE_BRIDGE_PORT: actual === 1 ? "2" : "1" } },
  });
  try {
    await expect(runtime.acquire()).rejects.toThrow("restart JAgentDesk to apply the bridge port");
  } finally {
    await runtime.shutdown();
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});

// Spec 04 §5: a client the registry replaced must not leave its `opencode serve` running.
test("retire stops an idle owned server and keeps a leased one until it is released", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jagentdesk-opencode-retire-"));
  const script = path.join(root, "server.cjs");
  await writeFile(
    script,
    `
    const http = require('node:http');
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ version: '2.0.10', pid: process.pid, urls: [], paths: { tmp: '/tmp' } }));
    });
    server.listen(0, '127.0.0.1', () => console.log('server listening on http://127.0.0.1:' + server.address().port));
  `,
  );
  const settings = { command: { mode: "replace" as const, argv: [process.execPath, script] } };
  const idleRuntime = new V2Runtime({
    logger: createTestLogger(),
    selection: { kind: "owned" },
    settings,
  });
  const leasedRuntime = new V2Runtime({
    logger: createTestLogger(),
    selection: { kind: "owned" },
    settings,
  });
  try {
    const idle = await idleRuntime.acquire();
    const idleExited = idle.exited;
    await idle.release();
    await idleRuntime.retire();
    await expect(idleExited).resolves.toBeInstanceOf(Error);
    await expect(idleRuntime.acquire()).rejects.toThrow("OpenCode runtime is closed");

    const leased = await leasedRuntime.acquire();
    const { pid } = await leased.client.server.info();
    await leasedRuntime.retire();
    expect(() => process.kill(pid, 0)).not.toThrow();
    const leasedExited = leased.exited;
    await leased.release();
    await expect(leasedExited).resolves.toBeInstanceOf(Error);
  } finally {
    await idleRuntime.shutdown();
    await leasedRuntime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("a wrapped caller gets its own helper behind the wrap, and other callers keep the shared one", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jagentdesk-opencode-wrap-"));
  const script = path.join(root, "server.cjs");
  const launcher = path.join(root, "launcher.cjs");
  const record = path.join(root, "argv.json");
  await writeFile(
    script,
    `
    const http = require('node:http');
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ version: '2.0.10', pid: process.pid, urls: [], paths: { tmp: '/tmp' } }));
    });
    server.listen(0, '127.0.0.1', () => console.log('server listening on http://127.0.0.1:' + server.address().port));
  `,
  );
  await writeFile(
    launcher,
    `
    const [, , ...argv] = process.argv;
    // A launcher that needs its profile from the open hook's environment.
    if (!process.env.SANDBOX_PROFILE) process.exit(17);
    require('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv, profile: process.env.SANDBOX_PROFILE }));
    const child = require('node:child_process').spawn(argv[1], argv.slice(2), { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 1));
  `,
  );
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    selection: { kind: "owned" },
    settings: { command: { mode: "replace", argv: [process.execPath, script] } },
  });
  try {
    const shared = await runtime.acquire();
    const wrapped = await runtime.acquire({
      dedicated: true,
      wrap: [process.execPath, launcher, "--profile"],
      env: { SANDBOX_PROFILE: "agent" },
    });
    const sharedAgain = await runtime.acquire();

    const sharedPid = (await shared.client.server.info()).pid;
    expect((await wrapped.client.server.info()).pid).not.toBe(sharedPid);
    expect((await sharedAgain.client.server.info()).pid).toBe(sharedPid);
    const launched = JSON.parse(await readFile(record, "utf8"));
    expect(launched.profile).toBe("agent");
    expect(launched.argv.slice(0, 4)).toEqual(["--profile", process.execPath, script, "serve"]);

    await wrapped.release();
    await expect(wrapped.exited).resolves.toBeInstanceOf(Error);
    await shared.release();
    await sharedAgain.release();
  } finally {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("refuses to wrap a configured existing server", async () => {
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    selection: { kind: "explicit", server: { url: "http://127.0.0.1:1" } },
  });
  try {
    await expect(
      runtime.acquire({ dedicated: true, wrap: ["/opt/sandbox/bin/run"], env: {} }),
    ).rejects.toThrow("cannot start it behind a launch wrap");
  } finally {
    await runtime.shutdown();
  }
});
