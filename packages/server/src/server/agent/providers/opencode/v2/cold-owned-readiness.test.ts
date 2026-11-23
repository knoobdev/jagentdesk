import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { createTestLogger } from "../../../../../test-utils/test-logger.js";
import { V2Runtime } from "./runtime.js";
import { waitForLocationReady } from "./readiness.js";
import { attachMcpServers } from "./mcp-attach.js";

test("a cold owned server finishes activation and mounts MCP before its first provider request", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jagentdesk-cold-owned-"));
  vi.stubEnv("JAGENTDESK_HOME", path.join(root, "jagentdesk"));
  const record = path.join(root, "requests.jsonl");
  const script = path.join(root, "opencode.cjs");
  const requests: unknown[] = [];
  const provider = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Provider did not listen");
  const baseURL = `http://127.0.0.1:${address.port}`;
  await writeFile(
    script,
    `
    const http = require('node:http');
    const fs = require('node:fs');
    const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
    const location = { directory: ${JSON.stringify(root)} };
    let activation;
    let canceled = false;
    let active = false;
    let mcp = 'pending';
    const server = http.createServer(async (request, response) => {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify(pathname) + '\\n');
      const json = (value) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (pathname === '/api/info')
        return json({ version: '2.0.10', pid: process.pid, urls: [], paths: { tmp: '/tmp' } });
      if (pathname === '/api/plugin') {
        if (active) return json({ location, data: [{ id: 'jagentdesk', state: { status: 'active' } }] });
        if (canceled) return json({ location, data: [] });
        // The cold graph belongs to the activating request. Interrupting that
        // request interrupts activation; polling its empty inventory cannot recover it.
        activation = setTimeout(() => {
          active = true;
          json({ location, data: [{ id: 'jagentdesk', state: { status: 'active' } }] });
        }, 6000);
        response.on('close', () => {
          if (!response.writableFinished) { clearTimeout(activation); canceled = true; }
        });
        return;
      }
      if (pathname === '/api/experimental/mcp/jagentdesk') {
        for await (const _ of request) {}
        mcp = 'connected'; // OpenCode publishes this only after tools/list succeeds.
        response.writeHead(204).end();
        return;
      }
      if (pathname === '/api/mcp') return json({ location, data: [{ name: 'jagentdesk', status: { status: mcp } }] });
      if (pathname.endsWith('/context')) return json({ data: [] });
      if (pathname.endsWith('/prompt')) {
        if (!active || mcp !== 'connected') throw new Error('Prompt preceded readiness');
        const result = await fetch(config.provider.local.options.baseURL + '/chat/completions', {
          method: 'POST', body: JSON.stringify({ model: 'm1', tools: ['jagentdesk_list_agents'] }),
        });
        await result.text();
        return json({ data: { id: 'message' } });
      }
      response.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1', () => console.log('server listening on http://127.0.0.1:' + server.address().port));
  `,
  );
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    selection: { kind: "explicit", server: { url: "http://127.0.0.1:1" } },
    settings: {
      command: { mode: "replace", argv: [process.execPath, script] },
      env: { XDG_CONFIG_HOME: root },
    },
    providerConfigInjection: async () => ({
      id: "local",
      config: { name: "Local", options: { baseURL } },
    }),
  });
  const lifetime = new AbortController();
  const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)]);
  try {
    const connection = await runtime.acquire({ dedicated: true });
    await waitForLocationReady({
      client: connection.client,
      location: { directory: root },
      signal,
    });
    await attachMcpServers({
      client: connection.client,
      location: { directory: root },
      mcpServers: { jagentdesk: { type: "http", url: `${baseURL}/mcp` } },
      signal,
    });
    await connection.client.session.prompt({ sessionID: "cold", text: "hi" });
    expect(requests).toEqual([{ model: "m1", tools: ["jagentdesk_list_agents"] }]);
    expect((await readFile(record, "utf8")).split("\n")).not.toContain(
      '"/api/session/cold/context"',
    );
    await connection.release();
  } finally {
    lifetime.abort();
    await runtime.shutdown();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  }
}, 12_000);
