import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import type { ProxyHeader } from "@jagentdesk/protocol/proxy/rpc-schemas";
import type { WorkbenchCA } from "./ca.js";
import { CaptureStore, type StoredTransaction } from "./capture-store.js";
import { WsFrameParser } from "./ws-tap.js";

// The intercepting MITM proxy for one capture session. Runs as a forward proxy on an ephemeral
// local port: plain HTTP is proxied directly; HTTPS is terminated with a per-host certificate
// signed by the Workbench CA, inspected, then re-originated to the upstream. Each completed
// transaction is stored and handed to `onTransaction` for the live stream. Built on node core so
// there is no native dependency. Upstream certs are not verified (a testing proxy must reach hosts
// with self-signed / pinned certs) — the client's trust decision is the CA it installed for us.

export interface InterceptInput {
  secure: boolean;
  host: string;
  port: number;
  method: string;
  path: string;
  headers: ProxyHeader[];
  body: Buffer;
}
export interface InterceptOutcome {
  drop: boolean;
  method: string;
  path: string;
  headers: ProxyHeader[];
  body: Buffer;
}

export interface MitmProxyOptions {
  ca: WorkbenchCA;
  sessionId: string;
  store: CaptureStore;
  onTransaction: (tx: StoredTransaction) => void;
  udid?: string | null;
  bundleId?: string | null;
  host?: string; // listener bind address, default 127.0.0.1
  port?: number; // fixed listener port; 0/undefined = ephemeral
  // When set, each request is offered for interception before it is forwarded (Burp Intercept).
  intercept?: (input: InterceptInput) => Promise<InterceptOutcome>;
  // When set, WebSocket data frames passing through the tunnel are reported (Burp WebSockets history).
  onWsMessage?: (msg: {
    direction: "to-server" | "to-client";
    opcode: number;
    payload: Buffer;
    host: string;
  }) => void;
}

interface SocketTarget {
  host: string;
  port: number;
}

export class MitmProxy {
  private readonly opts: MitmProxyOptions;
  private server: http.Server | null = null;
  private tlsTerminator: https.Server | null = null;
  private readonly connectTargets = new WeakMap<Duplex, SocketTarget>();
  private seq = 0;
  private listenerPort = 0;
  private readonly listenerHost: string;

  constructor(opts: MitmProxyOptions) {
    this.opts = opts;
    this.listenerHost = opts.host ?? "127.0.0.1";
  }

  get port(): number {
    return this.listenerPort;
  }
  get boundHost(): string {
    return this.listenerHost;
  }

  async start(): Promise<number> {
    // One TLS terminator handles every intercepted HTTPS connection; SNICallback mints the right
    // leaf cert per hostname. Decrypted requests land in `handleDecryptedRequest`.
    this.tlsTerminator = https.createServer(
      {
        SNICallback: (servername, cb) => {
          try {
            const { certPem, keyPem } = this.opts.ca.certForHost(servername);
            cb(null, tls.createSecureContext({ cert: certPem, key: keyPem }));
          } catch (err) {
            cb(err as Error);
          }
        },
      },
      (req, res) => this.handleDecryptedRequest(req, res),
    );
    this.tlsTerminator.on("upgrade", (req, socket) => this.tunnelUpgrade(req, socket));

    this.server = http.createServer((req, res) => this.handlePlainRequest(req, res));
    this.server.on("connect", (req, socket, head) => this.handleConnect(req, socket, head));
    this.server.on("upgrade", (req, socket) => this.tunnelUpgrade(req, socket));
    this.server.on("clientError", (_err, socket) => {
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    });

    await new Promise<void>((resolve, reject) => {
      const srv = this.server!;
      srv.once("error", reject);
      srv.listen(this.opts.port ?? 0, this.listenerHost, () => {
        const addr = srv.address();
        this.listenerPort = typeof addr === "object" && addr ? addr.port : 0;
        srv.removeListener("error", reject);
        resolve();
      });
    });
    return this.listenerPort;
  }

  async stop(): Promise<void> {
    await closeServer(this.server);
    await closeServer(this.tlsTerminator);
    this.server = null;
    this.tlsTerminator = null;
  }

  // ── HTTPS: client issued CONNECT host:port ──
  private handleConnect(req: http.IncomingMessage, clientSocket: Duplex, head: Buffer): void {
    const target = parseHostPort(req.url ?? "", 443);
    if (!target) {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    clientSocket.on("error", () => clientSocket.destroy());
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    this.connectTargets.set(clientSocket, target);
    if (head && head.length > 0) clientSocket.unshift(head);
    // Feed the raw client socket into the TLS terminator as if it were an inbound connection.
    this.tlsTerminator!.emit("connection", clientSocket);
  }

  // ── HTTP: client sent an absolute-form request (http://host/path) ──
  private handlePlainRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const parsed = safeParseUrl(req.url ?? "");
    if (!parsed) {
      res.writeHead(400);
      res.end("bad request");
      return;
    }
    const port = parsed.port ? Number(parsed.port) : 80;
    this.forward({
      req,
      res,
      secure: false,
      host: parsed.hostname,
      port,
      path: parsed.pathname + parsed.search,
    });
  }

  // ── HTTPS: a request decrypted by the TLS terminator ──
  private handleDecryptedRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const tlsSocket = req.socket as tls.TLSSocket;
    const underlying = (tlsSocket as unknown as { _parent?: Duplex })._parent;
    const target = underlying ? this.connectTargets.get(underlying) : undefined;
    const host = tlsSocket.servername || hostFromHeader(req) || target?.host || "";
    const port = target?.port ?? 443;
    if (!host) {
      res.writeHead(400);
      res.end("bad request");
      return;
    }
    this.forward({ req, res, secure: true, host, port, path: req.url ?? "/" });
  }

  private forward(input: {
    req: http.IncomingMessage;
    res: http.ServerResponse;
    secure: boolean;
    host: string;
    port: number;
    path: string;
  }): void {
    const { req, res, secure, host, port, path } = input;
    const startedAt = Date.now();
    const clientSocket = req.socket;
    collectBody(req, (rawBody) => {
      const rawHeaders = toHeaderPairs(req.rawHeaders);
      void this.applyIntercept({
        secure,
        host,
        port,
        method: req.method ?? "GET",
        path,
        headers: rawHeaders,
        body: rawBody,
      }).then((decision) => {
        if (decision.drop) {
          res.writeHead(403);
          res.end("workbench: request dropped");
          return;
        }
        const upstreamModule = secure ? https : http;
        const upstreamReq = upstreamModule.request(
          {
            host,
            port,
            method: decision.method,
            path: decision.path,
            headers: toOutgoingHeaders(decision.headers),
            rejectUnauthorized: false,
            servername: secure ? host : undefined,
          },
          (upstreamRes) => {
            collectBody(upstreamRes, (responseBody) => {
              const tx = this.buildTransaction({
                httpVersion: req.httpVersion,
                method: decision.method,
                secure,
                host,
                port,
                path: decision.path,
                requestBody: decision.body,
                requestHeaders: decision.headers,
                upstreamRes,
                responseBody,
                startedAt,
                clientIp: clientSocket.remoteAddress ?? "",
                clientPort: clientSocket.remotePort ?? 0,
                edited: decision.edited,
              });
              this.opts.store.add(tx);
              this.opts.onTransaction(tx);
              res.writeHead(
                upstreamRes.statusCode ?? 502,
                sanitizeResponseHeaders(upstreamRes.headers),
              );
              res.end(responseBody);
            });
          },
        );
        upstreamReq.on("error", (err) => {
          if (!res.headersSent) res.writeHead(502);
          res.end(`workbench upstream error: ${(err as Error).message}`);
        });
        if (decision.body.length) upstreamReq.write(decision.body);
        upstreamReq.end();
      });
    });
  }

  // Offer the request to the intercept hook (if any). Returns the possibly-edited request and
  // whether it was dropped or changed. Without a hook, the request passes through unchanged.
  private async applyIntercept(
    input: InterceptInput,
  ): Promise<InterceptOutcome & { edited: boolean }> {
    if (!this.opts.intercept) return { ...input, drop: false, edited: false };
    const outcome = await this.opts.intercept(input);
    const edited =
      !outcome.drop &&
      (outcome.method !== input.method ||
        outcome.path !== input.path ||
        !outcome.body.equals(input.body) ||
        JSON.stringify(outcome.headers) !== JSON.stringify(input.headers));
    return { ...outcome, edited };
  }

  private buildTransaction(i: {
    httpVersion: string;
    method: string;
    secure: boolean;
    host: string;
    port: number;
    path: string;
    requestBody: Buffer;
    requestHeaders: ProxyHeader[];
    upstreamRes: http.IncomingMessage;
    responseBody: Buffer;
    startedAt: number;
    clientIp: string;
    clientPort: number;
    edited: boolean;
  }): StoredTransaction {
    this.seq += 1;
    return {
      id: randomUUID(),
      sessionId: this.opts.sessionId,
      seq: this.seq,
      ts_ms: i.startedAt,
      secure: i.secure,
      host: i.host,
      port: i.port,
      method: i.method,
      url: i.path,
      clientIp: i.clientIp,
      clientPort: i.clientPort,
      udid: this.opts.udid ?? null,
      bundleId: this.opts.bundleId ?? null,
      requestLine: `${i.method} ${i.path} HTTP/${i.httpVersion}`,
      requestHeaders: i.requestHeaders,
      requestBody: i.requestBody,
      statusLine:
        `HTTP/${i.upstreamRes.httpVersion} ${i.upstreamRes.statusCode} ${i.upstreamRes.statusMessage ?? ""}`.trim(),
      status: i.upstreamRes.statusCode ?? null,
      responseHeaders: toHeaderPairs(i.upstreamRes.rawHeaders),
      responseBody: i.responseBody,
      durationMs: Date.now() - i.startedAt,
      edited: i.edited,
      comment: "",
      highlight: null,
    };
  }

  // WebSocket upgrades are tunneled through while WS data frames are observed in both directions
  // (Burp WebSockets history). Bytes are forwarded verbatim; the tap only reads a copy.
  private tunnelUpgrade(req: http.IncomingMessage, clientSocket: Duplex): void {
    const target = parseHostPort(req.headers.host ?? "", 80);
    if (!target) {
      clientSocket.destroy();
      return;
    }
    const host = target.host;
    const toServer = new WsFrameParser();
    const toClient = new WsFrameParser();
    const upstream = net.connect(target.port, target.host, () => {
      upstream.write(rebuildRequestHead(req));
      clientSocket.on("data", (chunk: Buffer) => {
        upstream.write(chunk);
        this.tapWs(toServer, chunk, "to-server", host);
      });
      upstream.on("data", (chunk: Buffer) => {
        clientSocket.write(chunk);
        this.tapWs(toClient, chunk, "to-client", host);
      });
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
    upstream.on("close", () => clientSocket.destroy());
    clientSocket.on("close", () => upstream.destroy());
  }

  private tapWs(
    parser: WsFrameParser,
    chunk: Buffer,
    direction: "to-server" | "to-client",
    host: string,
  ): void {
    if (!this.opts.onWsMessage) return;
    for (const frame of parser.push(chunk)) {
      this.opts.onWsMessage({ direction, opcode: frame.opcode, payload: frame.payload, host });
    }
  }
}

function closeServer(server: http.Server | https.Server | null): Promise<void> {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.close(() => resolve());
    // Force-resolve after a grace period so a lingering keep-alive socket can't hang stop().
    setTimeout(resolve, 1000).unref();
  });
}

function collectBody(stream: http.IncomingMessage, done: (body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  stream.on("end", () => done(Buffer.concat(chunks)));
  stream.on("error", () => done(Buffer.concat(chunks)));
}

function parseHostPort(input: string, defaultPort: number): SocketTarget | null {
  if (!input) return null;
  const withoutScheme = input.replace(/^[a-z]+:\/\//i, "");
  const hostPort = withoutScheme.split("/")[0] ?? "";
  const lastColon = hostPort.lastIndexOf(":");
  if (lastColon > 0 && lastColon > hostPort.lastIndexOf("]")) {
    const host = hostPort.slice(0, lastColon).replace(/[[\]]/g, "");
    const port = Number(hostPort.slice(lastColon + 1));
    if (host && Number.isFinite(port)) return { host, port };
  }
  if (hostPort) return { host: hostPort.replace(/[[\]]/g, ""), port: defaultPort };
  return null;
}

function safeParseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function hostFromHeader(req: http.IncomingMessage): string {
  const host = req.headers.host ?? "";
  const colon = host.lastIndexOf(":");
  return colon > 0 ? host.slice(0, colon) : host;
}

function toHeaderPairs(rawHeaders: string[]): ProxyHeader[] {
  const out: ProxyHeader[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    out.push({ name: rawHeaders[i]!, value: rawHeaders[i + 1]! });
  }
  return out;
}

// Turn the (possibly edited) header pairs back into outgoing headers, preserving order and
// duplicates, and dropping the proxy-only hop headers.
function toOutgoingHeaders(headers: ProxyHeader[]): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const h of headers) {
    const lower = h.name.toLowerCase();
    if (lower === "proxy-connection" || lower === "proxy-authorization") continue;
    const existing = out[h.name];
    if (existing === undefined) out[h.name] = h.value;
    else if (Array.isArray(existing)) existing.push(h.value);
    else out[h.name] = [String(existing), h.value];
  }
  return out;
}

// Drop hop-by-hop headers that Node manages itself when we re-emit the response.
function sanitizeResponseHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (lower === "transfer-encoding" || lower === "connection") continue;
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function rebuildRequestHead(req: http.IncomingMessage): string {
  const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
  }
  return lines.join("\r\n") + "\r\n\r\n";
}
