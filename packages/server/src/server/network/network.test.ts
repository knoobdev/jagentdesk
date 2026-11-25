import { fork } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { connect, createServer as createTcpServer } from "node:net";
import { connectThroughProxy } from "../ssh/proxy-socket.js";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import pino from "pino";
import { startRelayTransport } from "../relay-transport.js";
import { relayChallengeMessage } from "@jagentdesk/relay/ownership";
import { afterEach, expect, test } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { initializeEnvironmentProxy, webSocketProxyAgent } from "./index.js";
const original = getGlobalDispatcher();
const servers: Server[] = [];
afterEach(async () => {
  const installed = getGlobalDispatcher();
  setGlobalDispatcher(original);
  if (installed !== original) await installed.close();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
async function listen(server: Server) {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  return `127.0.0.1:${address.port}`;
}
async function proxy() {
  const tunnels: string[] = [];
  const server = createServer();
  server.on("connect", (request, socket) => {
    tunnels.push(request.url!);
    socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
  });
  return { url: `http://${await listen(server)}`, tunnels };
}
test("loopback fetch and WebSockets bypass HTTP_PROXY with empty NO_PROXY", async () => {
  const recorder = await proxy();
  initializeEnvironmentProxy({ HTTP_PROXY: recorder.url, NO_PROXY: "" });
  const server = createServer((_, response) => response.end("direct"));
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) => socket.send("direct"));
  const address = await listen(server);
  expect(await (await fetch(`http://${address}`)).text()).toBe("direct");
  const socket = new WebSocket(`ws://${address}`, {
    agent: webSocketProxyAgent(`ws://${address}`),
  });
  expect((await once(socket, "message"))[0].toString()).toBe("direct");
  socket.close();
  await once(socket, "close");
  await new Promise<void>((resolve) => sockets.close(() => resolve()));
  for (const host of ["localhost", "127.0.0.1", "[::1]"])
    expect(webSocketProxyAgent(`wss://${host}:1234`)).toBeUndefined();
  expect(recorder.tunnels).toEqual([]);
});
test("fetch and WebSockets send non-loopback traffic through CONNECT", async () => {
  const recorder = await proxy();
  initializeEnvironmentProxy({ http_proxy: recorder.url });
  await expect(
    fetch("https://vendor.invalid/", { signal: AbortSignal.timeout(500) }),
  ).rejects.toThrow();
  const socket = new WebSocket("wss://vendor.invalid", {
    agent: webSocketProxyAgent("wss://vendor.invalid"),
  });
  await once(socket, "error");
  expect(
    recorder.tunnels.filter((host) => host === "vendor.invalid:443").length,
  ).toBeGreaterThanOrEqual(2);
});
test("NO_PROXY and absent variables keep matching WebSockets direct", async () => {
  const recorder = await proxy();
  initializeEnvironmentProxy({
    HTTPS_PROXY: recorder.url,
    NO_PROXY: "vendor.invalid,.example.invalid:443",
  });
  expect(webSocketProxyAgent("wss://vendor.invalid")).toBeUndefined();
  await expect(
    fetch("https://vendor.invalid/", { signal: AbortSignal.timeout(500) }),
  ).rejects.toThrow();
  expect(webSocketProxyAgent("wss://sub.example.invalid")).toBeUndefined();
  expect(webSocketProxyAgent("wss://example.invalid:444")).toBeDefined();
  initializeEnvironmentProxy({ HTTP_PROXY: recorder.url, no_proxy: "*" });
  expect(webSocketProxyAgent("ws://vendor.invalid")).toBeUndefined();
  initializeEnvironmentProxy({});
  expect(webSocketProxyAgent("wss://vendor.invalid")).toBeUndefined();
  const address = await listen(createServer((_, response) => response.end("direct")));
  expect(await (await fetch(`http://${address}`)).text()).toBe("direct");
  expect(recorder.tunnels).toEqual([]);
});

test.each(["127.0.0.1", "localhost"])(
  "scheme-less %s proxies work for fetch and WebSockets",
  async (host) => {
    const recorder = await proxy();
    const address = new URL(recorder.url);
    initializeEnvironmentProxy({ https_proxy: `${host}:${address.port}` });
    await expect(
      fetch("https://vendor.invalid", { signal: AbortSignal.timeout(500) }),
    ).rejects.toThrow();
    const socket = new WebSocket("wss://vendor.invalid", {
      agent: webSocketProxyAgent("wss://vendor.invalid"),
    });
    await once(socket, "error");
    expect(recorder.tunnels).toContain("vendor.invalid:443");
  },
);

test.each([
  "http://[",
  "http://user%zz:secret@proxy.corp",
  "socks5://127.0.0.1:7890",
  "ftp://proxy.corp:8080",
])("ignores invalid or unsupported proxy %s without stopping startup", async (value) => {
  const recorder = await proxy();
  expect(initializeEnvironmentProxy({ HTTP_PROXY: recorder.url, https_proxy: value })).toEqual([
    "https_proxy",
  ]);
  expect(webSocketProxyAgent("wss://vendor.invalid")).toBeDefined();
  await expect(
    fetch("https://vendor.invalid", { signal: AbortSignal.timeout(500) }),
  ).rejects.toThrow();
  const socket = new WebSocket("wss://vendor.invalid", {
    agent: webSocketProxyAgent("wss://vendor.invalid"),
  });
  await once(socket, "error");
  expect(recorder.tunnels).toEqual(["vendor.invalid:443", "vendor.invalid:443"]);
});

test("daemon starts with an ignored proxy and writes one redacted warning to daemon.log", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "daemon-invalid-proxy-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !["http_proxy", "https_proxy"].includes(key.toLowerCase()),
    ),
  );
  const worker = fork(fileURLToPath(new URL("../daemon-worker.ts", import.meta.url)), [], {
    execArgv: ["--import", "tsx"],
    silent: true,
    env: {
      ...env,
      JAGENTDESK_HOME: home,
      HOME: home,
      USERPROFILE: home,
      JAGENTDESK_LISTEN: "127.0.0.1:0",
      JAGENTDESK_RELAY_ENABLED: "0",
      JAGENTDESK_TAILSCALE_ENABLED: "0",
      JAGENTDESK_VOICE_MODE_ENABLED: "0",
      JAGENTDESK_DICTATION_ENABLED: "0",
      https_proxy: "socks5://private:secret@127.0.0.1:7890",
    },
  });
  worker.stdout?.resume();
  let stderr = "";
  worker.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      worker.on("message", (message) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "jagentdesk:ready"
        )
          resolve();
      });
      worker.on("exit", (code) => reject(new Error(`Worker exited ${code}: ${stderr}`)));
    });
    const log = await readFile(path.join(home, "daemon.log"), "utf8");
    const warnings = log
      .split("\n")
      .filter((line) => line.includes("Ignoring invalid or unsupported HTTP proxy variable"));
    expect(warnings).toHaveLength(1);
    expect(JSON.parse(warnings[0]!).variable).toBe("https_proxy");
    expect(warnings[0]).not.toContain("secret");
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) {
      const exited = once(worker, "exit");
      worker.kill("SIGTERM");
      await exited;
    }
    await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}, 60_000);

test("accepts a scheme-less corporate proxy hostname", () => {
  expect(initializeEnvironmentProxy({ https_proxy: "proxy.corp:8080" })).toEqual([]);
  expect(webSocketProxyAgent("wss://vendor.invalid")).toBeDefined();
});

test("an ignored lowercase variable falls back to the uppercase variable", async () => {
  const recorder = await proxy();
  expect(
    initializeEnvironmentProxy(
      {
        https_proxy: "socks5://proxy.invalid",
        HTTPS_PROXY: recorder.url,
      },
      "linux",
    ),
  ).toEqual(["https_proxy"]);
  await expect(
    fetch("https://vendor.invalid", { signal: AbortSignal.timeout(500) }),
  ).rejects.toThrow();
  const socket = new WebSocket("wss://vendor.invalid", {
    agent: webSocketProxyAgent("wss://vendor.invalid"),
  });
  await once(socket, "error");
  expect(recorder.tunnels).toEqual(["vendor.invalid:443", "vendor.invalid:443"]);
});

test("case-insensitive environment access reports a variable only once", () => {
  const env = new Proxy(
    { https_proxy: "socks5://127.0.0.1:7890" },
    {
      get(target, key) {
        return Reflect.get(target, typeof key === "string" ? key.toLowerCase() : key);
      },
    },
  );
  expect(initializeEnvironmentProxy(env)).toEqual(["https_proxy"]);
});

test("Windows mixed-case environment names route and bypass both transports", async () => {
  const recorder = await proxy();
  // Windows preserves spelling but treats environment names without regard to case.
  initializeEnvironmentProxy({ Https_Proxy: recorder.url, No_Proxy: "other.invalid" }, "win32");
  expect(webSocketProxyAgent("wss://other.invalid")).toBeUndefined();
  await expect(
    fetch("https://other.invalid", { signal: AbortSignal.timeout(500) }),
  ).rejects.toThrow();
  expect(webSocketProxyAgent("wss://vendor.invalid")).toBeDefined();
  await expect(
    fetch("https://vendor.invalid", { signal: AbortSignal.timeout(500) }),
  ).rejects.toThrow();
  const socket = new WebSocket("wss://vendor.invalid", {
    agent: webSocketProxyAgent("wss://vendor.invalid"),
  });
  await once(socket, "error");
  expect(recorder.tunnels).toEqual(["vendor.invalid:443", "vendor.invalid:443"]);
});

test("POSIX mixed-case names do not override standard proxy names", async () => {
  const recorder = await proxy();
  initializeEnvironmentProxy(
    { Https_Proxy: recorder.url, HTTPS_PROXY: recorder.url, No_Proxy: "*" },
    "linux",
  );
  expect(webSocketProxyAgent("wss://vendor.invalid")).toBeDefined();
  await expect(
    fetch("https://vendor.invalid", { signal: AbortSignal.timeout(500) }),
  ).rejects.toThrow();
  expect(recorder.tunnels).toEqual(["vendor.invalid:443"]);
});

test("proxy credentials stay on CONNECT and do not reach the HTTP origin", async () => {
  let originAuthorization: string | undefined;
  const origin = createServer((request, response) => {
    originAuthorization = request.headers["proxy-authorization"];
    response.end("through proxy");
  });
  const originAddress = new URL(`http://${await listen(origin)}`);
  const authorizations: (string | undefined)[] = [];
  const server = createServer();
  server.on("connect", (request, socket, head) => {
    authorizations.push(request.headers["proxy-authorization"]);
    const upstream = connect(Number(originAddress.port), "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
  });
  initializeEnvironmentProxy({ HTTP_PROXY: `http://user:@${await listen(server)}` });
  const response = await fetch("http://vendor.invalid", { signal: AbortSignal.timeout(3000) });
  expect(await response.text()).toBe("through proxy");
  expect(authorizations).toEqual([`Basic ${Buffer.from("user:").toString("base64")}`]);
  expect(originAuthorization).toBeUndefined();
});

test.each(["user:@", ":secret@", "user:secret@"])(
  "fetch and WebSockets authenticate proxy credentials %s",
  async (credentials) => {
    const authorizations: (string | undefined)[] = [];
    const server = createServer();
    server.on("connect", (request, socket) => {
      authorizations.push(request.headers["proxy-authorization"]);
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
    initializeEnvironmentProxy({ HTTPS_PROXY: `http://${credentials}${await listen(server)}` });
    await expect(
      fetch("https://vendor.invalid", { signal: AbortSignal.timeout(500) }),
    ).rejects.toThrow();
    const socket = new WebSocket("wss://vendor.invalid", {
      agent: webSocketProxyAgent("wss://vendor.invalid"),
    });
    await once(socket, "error");
    const expected = `Basic ${Buffer.from(credentials.slice(0, -1)).toString("base64")}`;
    expect(authorizations).toEqual([expected, expected]);
  },
);

test("relay control and data sockets bypass proxies with a conflicting NO_PROXY", async () => {
  const recorder = await proxy();
  initializeEnvironmentProxy({
    HTTP_PROXY: recorder.url,
    HTTPS_PROXY: recorder.url,
    NO_PROXY: "unrelated.invalid",
  });
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "jwk" });
  const server = createServer((_, response) => response.end("direct"));
  const sockets = new WebSocketServer({ server });
  const authenticated: string[] = [];
  const attached = Promise.withResolvers<void>();
  sockets.on("connection", (socket, request) => {
    const url = new URL(request.url!, "http://localhost");
    const connectionId = url.searchParams.get("connectionId");
    const nonce = connectionId ?? "control-challenge";
    socket.send(JSON.stringify({ type: "relay_challenge", v: 1, nonce }));
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (message.type !== "relay_auth") return;
      expect(message.publicKey).toBe(publicKey.x);
      expect(
        verify(
          null,
          Buffer.from(relayChallengeMessage("srv_proxy_test", nonce)),
          keys.publicKey,
          Buffer.from(message.signature, "base64url"),
        ),
      ).toBe(true);
      authenticated.push(connectionId ?? "control");
      socket.send(JSON.stringify({ type: "relay_auth_ok" }));
      if (connectionId) attached.resolve();
      else socket.send(JSON.stringify({ type: "connected", connectionId: "data-proxy-test" }));
    });
  });
  const endpoint = await listen(server);
  const controller = startRelayTransport({
    logger: pino({ level: "silent" }),
    relayEndpoint: endpoint,
    relayUseTls: false,
    serverId: "srv_proxy_test",
    relayOwnership: {
      publicKeyB64url: publicKey.x!,
      signOwnership(serverId, nonce) {
        return sign(
          null,
          Buffer.from(relayChallengeMessage(serverId, nonce)),
          keys.privateKey,
        ).toString("base64url");
      },
    },
    attachSocket: async () => {},
  });
  try {
    await attached.promise;
    expect(authenticated).toEqual(["control", "data-proxy-test"]);
    expect(webSocketProxyAgent("wss://127.0.0.1:41823")).toBeUndefined();
    expect(await (await fetch(`http://${endpoint}/health`)).text()).toBe("direct");
    expect(recorder.tunnels).toEqual([]);
  } finally {
    await controller.stop();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
  }
}, 15_000);

test("tsnet loopback SOCKS dial bypasses HTTP proxy and NO_PROXY settings", async () => {
  const recorder = await proxy();
  initializeEnvironmentProxy({
    HTTP_PROXY: recorder.url,
    HTTPS_PROXY: recorder.url,
    NO_PROXY: "unrelated.invalid",
  });
  const requests: Buffer[] = [];
  const server = createTcpServer((socket) => {
    let greeted = false;
    socket.on("data", (chunk: Buffer) => {
      requests.push(chunk);
      if (!greeted) {
        greeted = true;
        socket.write(Buffer.from([5, 0]));
      } else {
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 22]));
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing SOCKS address");
  try {
    const socket = await connectThroughProxy(
      { type: "socks5", host: "127.0.0.1", port: address.port },
      "100.64.0.2",
      22,
    );
    socket.destroy();
    expect(requests).toEqual([
      Buffer.from([5, 1, 0]),
      Buffer.from([5, 1, 0, 1, 100, 64, 0, 2, 0, 22]),
    ]);
    expect(recorder.tunnels).toEqual([]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
