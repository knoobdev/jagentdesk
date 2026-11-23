import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import pino from "pino";
import { expect, it } from "vitest";
import { MemorySecretStore } from "../database/secret-store.js";
import { ArgoCdConnection, secretKeys } from "./connection.js";
import { AppsHub } from "./streams.js";

it("closes a pending SSE connection after a built-in toggle, then permits resubscription", async () => {
  let notifyRequest!: () => void;
  const requested = new Promise<void>((resolve) => {
    notifyRequest = resolve;
  });
  const streams: ServerResponse[] = [];
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/api/v1/stream/applications")) {
      streams.push(response);
      if (streams.length === 1) notifyRequest();
      else {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.flushHeaders();
      }
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ items: [] }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No listener");
  const secrets = new MemorySecretStore();
  await secrets.set(secretKeys.token("local"), "local-test-token");
  const logger = pino({ level: "silent" });
  const connection = new ArgoCdConnection(
    {
      id: "local",
      url: `http://127.0.0.1:${address.port}`,
      displayName: "Local Argo CD",
      authMethod: "token",
      username: null,
      tlsSkipVerify: false,
      caPem: null,
      headers: [],
      rememberPassword: false,
      createdAt_ms: 0,
    },
    { secrets, logger, onChange: () => {} },
  );
  await connection.load();
  const hub = new AppsHub(connection, logger);
  const listener = () => {};
  try {
    const subscribing = hub.subscribe(listener);
    await requested;
    hub.stop();
    streams[0]!.writeHead(200, { "content-type": "text/event-stream" });
    streams[0]!.flushHeaders();
    expect(await subscribing).toEqual([]);
    await expect.poll(() => streams[0]!.destroyed).toBe(true);
    hub.unsubscribe(listener);
    const second = () => {};
    expect(await hub.subscribe(second)).toEqual([]);
    expect(streams).toHaveLength(2);
    expect(streams[1]!.destroyed).toBe(false);
    hub.unsubscribe(second);
    await expect.poll(() => streams[1]!.destroyed).toBe(true);
  } finally {
    hub.stop();
    connection.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});
