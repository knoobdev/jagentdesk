import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import type { ProxyHeader } from "@jagentdesk/protocol/proxy/rpc-schemas";
import type { StoredTransaction } from "./capture-store.js";

// Executes a single arbitrary request and returns it as a StoredTransaction — the engine behind
// Burp Repeater. Unlike the MITM path there is no client to relay to; the daemon originates the
// request itself and hands back the full request/response pair. Upstream certs are not verified,
// as a testing tool must reach hosts with self-signed / pinned certs.

export interface ExecuteRequestInput {
  secure: boolean;
  host: string;
  port: number;
  method: string;
  path: string;
  headers: ProxyHeader[];
  body: Buffer;
}

export function executeRequest(input: ExecuteRequestInput): Promise<StoredTransaction> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const mod = input.secure ? https : http;
    const headers: http.OutgoingHttpHeaders = {};
    for (const h of input.headers) {
      if (h.name.toLowerCase() === "content-length") continue;
      const existing = headers[h.name];
      if (existing === undefined) headers[h.name] = h.value;
      else if (Array.isArray(existing)) existing.push(h.value);
      else headers[h.name] = [String(existing), h.value];
    }
    const req = mod.request(
      {
        host: input.host,
        port: input.port,
        method: input.method,
        path: input.path,
        headers,
        rejectUnauthorized: false,
        servername: input.secure ? input.host : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve(
            buildTx(
              input,
              startedAt,
              chunks,
              res.statusCode ?? null,
              res.statusMessage ?? "",
              res.rawHeaders,
              res.httpVersion,
            ),
          );
        });
        res.on("error", () => {
          resolve(
            buildTx(
              input,
              startedAt,
              chunks,
              res.statusCode ?? null,
              "",
              res.rawHeaders,
              res.httpVersion,
            ),
          );
        });
      },
    );
    req.on("error", (err) => {
      resolve(buildErrorTx(input, startedAt, (err as Error).message));
    });
    if (input.body.length) req.write(input.body);
    req.end();
  });
}

function buildTx(
  input: ExecuteRequestInput,
  startedAt: number,
  chunks: Buffer[],
  status: number | null,
  statusMessage: string,
  rawHeaders: string[],
  httpVersion: string,
): StoredTransaction {
  const responseBody = Buffer.concat(chunks);
  return {
    id: randomUUID(),
    sessionId: "repeater",
    seq: 0,
    ts_ms: startedAt,
    secure: input.secure,
    host: input.host,
    port: input.port,
    method: input.method,
    url: input.path,
    clientIp: "127.0.0.1",
    clientPort: 0,
    udid: null,
    bundleId: null,
    requestLine: `${input.method} ${input.path} HTTP/1.1`,
    requestHeaders: input.headers,
    requestBody: input.body,
    statusLine: `HTTP/${httpVersion} ${status ?? ""} ${statusMessage}`.trim(),
    status,
    responseHeaders: toPairs(rawHeaders),
    responseBody,
    durationMs: Date.now() - startedAt,
    edited: false,
    comment: "",
    highlight: null,
  };
}

function buildErrorTx(
  input: ExecuteRequestInput,
  startedAt: number,
  message: string,
): StoredTransaction {
  return {
    id: randomUUID(),
    sessionId: "repeater",
    seq: 0,
    ts_ms: startedAt,
    secure: input.secure,
    host: input.host,
    port: input.port,
    method: input.method,
    url: input.path,
    clientIp: "127.0.0.1",
    clientPort: 0,
    udid: null,
    bundleId: null,
    requestLine: `${input.method} ${input.path} HTTP/1.1`,
    requestHeaders: input.headers,
    requestBody: input.body,
    statusLine: "",
    status: null,
    responseHeaders: [],
    responseBody: Buffer.from(`workbench repeater error: ${message}`, "utf8"),
    durationMs: Date.now() - startedAt,
    edited: false,
    comment: "",
    highlight: null,
  };
}

function toPairs(rawHeaders: string[]): ProxyHeader[] {
  const out: ProxyHeader[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2)
    out.push({ name: rawHeaders[i]!, value: rawHeaders[i + 1]! });
  return out;
}
