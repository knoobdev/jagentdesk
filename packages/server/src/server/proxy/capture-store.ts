import zlib from "node:zlib";
import type {
  ProxyHeader,
  ProxyTransactionFull,
  ProxyTransactionRow,
} from "@jagentdesk/protocol/proxy/rpc-schemas";

// In-memory store of intercepted HTTP transactions, one ring buffer per capture session. Security
// testing keeps full request/response bodies, so we cap per session (a ring) to bound memory; the
// query surface mirrors Burp's HTTP-history filter (host / method / status / free-text contains).
// Bodies stay as Buffers here and are base64-encoded only when a full transaction crosses the wire.

const DEFAULT_CAP = 5000;
const MAX_BODY_BYTES = 5 * 1024 * 1024; // bodies larger than this are truncated in the store

export interface StoredTransaction {
  id: string;
  sessionId: string;
  seq: number;
  ts_ms: number;
  secure: boolean;
  host: string;
  port: number;
  method: string;
  url: string;
  clientIp: string;
  clientPort: number;
  udid: string | null;
  bundleId: string | null;
  requestLine: string;
  requestHeaders: ProxyHeader[];
  requestBody: Buffer;
  statusLine: string;
  status: number | null;
  responseHeaders: ProxyHeader[];
  responseBody: Buffer;
  durationMs: number | null;
  edited: boolean;
  comment: string;
  highlight: string | null;
}

export interface HistoryQuery {
  sessionId: string | null;
  host?: string;
  method?: string;
  status?: number;
  contains?: string;
  limit?: number;
}

export class CaptureStore {
  private readonly bySession = new Map<string, StoredTransaction[]>();
  private readonly byId = new Map<string, StoredTransaction>();
  private readonly cap: number;

  constructor(cap: number = DEFAULT_CAP) {
    this.cap = cap;
  }

  add(tx: StoredTransaction): void {
    if (tx.requestBody.length > MAX_BODY_BYTES)
      tx.requestBody = tx.requestBody.subarray(0, MAX_BODY_BYTES);
    if (tx.responseBody.length > MAX_BODY_BYTES)
      tx.responseBody = tx.responseBody.subarray(0, MAX_BODY_BYTES);
    let list = this.bySession.get(tx.sessionId);
    if (!list) {
      list = [];
      this.bySession.set(tx.sessionId, list);
    }
    list.push(tx);
    this.byId.set(tx.id, tx);
    while (list.length > this.cap) {
      const dropped = list.shift();
      if (dropped) this.byId.delete(dropped.id);
    }
  }

  get(id: string): StoredTransaction | undefined {
    return this.byId.get(id);
  }

  countForSession(sessionId: string): number {
    return this.bySession.get(sessionId)?.length ?? 0;
  }

  dropSession(sessionId: string): void {
    const list = this.bySession.get(sessionId);
    if (list) for (const tx of list) this.byId.delete(tx.id);
    this.bySession.delete(sessionId);
  }

  query(q: HistoryQuery): StoredTransaction[] {
    const pools = q.sessionId
      ? [this.bySession.get(q.sessionId) ?? []]
      : [...this.bySession.values()];
    const hostNeedle = q.host?.toLowerCase();
    const methodNeedle = q.method?.toUpperCase();
    const containsNeedle = q.contains?.toLowerCase();
    const out: StoredTransaction[] = [];
    for (const pool of pools) {
      for (const tx of pool) {
        if (hostNeedle && !tx.host.toLowerCase().includes(hostNeedle)) continue;
        if (methodNeedle && tx.method.toUpperCase() !== methodNeedle) continue;
        if (q.status != null && tx.status !== q.status) continue;
        if (containsNeedle && !transactionContains(tx, containsNeedle)) continue;
        out.push(tx);
      }
    }
    out.sort((a, b) => b.ts_ms - a.ts_ms || b.seq - a.seq);
    return q.limit && q.limit > 0 ? out.slice(0, q.limit) : out;
  }
}

function transactionContains(tx: StoredTransaction, needle: string): boolean {
  if (tx.url.toLowerCase().includes(needle)) return true;
  if (tx.requestBody.toString("utf8").toLowerCase().includes(needle)) return true;
  if (tx.responseBody.toString("utf8").toLowerCase().includes(needle)) return true;
  for (const h of tx.requestHeaders) {
    if (`${h.name}: ${h.value}`.toLowerCase().includes(needle)) return true;
  }
  for (const h of tx.responseHeaders) {
    if (`${h.name}: ${h.value}`.toLowerCase().includes(needle)) return true;
  }
  return false;
}

// ── projections to the wire shapes ──

export function toRow(tx: StoredTransaction): ProxyTransactionRow {
  const mimeType = headerValue(tx.responseHeaders, "content-type").split(";")[0]?.trim() ?? "";
  return {
    id: tx.id,
    sessionId: tx.sessionId,
    seq: tx.seq,
    ts_ms: tx.ts_ms,
    secure: tx.secure,
    host: tx.host,
    port: tx.port,
    method: tx.method,
    url: tx.url,
    paramCount: countParams(tx),
    status: tx.status,
    responseLength: tx.status == null ? null : tx.responseBody.length,
    mimeType,
    extension: extensionOf(tx.url),
    title: parseTitle(tx.responseBody, mimeType),
    clientIp: tx.clientIp,
    clientPort: tx.clientPort,
    udid: tx.udid,
    bundleId: tx.bundleId,
    durationMs: tx.durationMs,
    edited: tx.edited,
    comment: tx.comment,
    highlight: tx.highlight,
  };
}

export function toFull(tx: StoredTransaction): ProxyTransactionFull {
  // Display bodies are decompressed (gzip/deflate/br) the way Burp shows them — the stored/served
  // bytes stay compressed, but a reader wants the plaintext. Headers are kept as-is.
  const reqBody = decodeBody(tx.requestHeaders, tx.requestBody);
  const resBody = decodeBody(tx.responseHeaders, tx.responseBody);
  return {
    ...toRow(tx),
    requestLine: tx.requestLine,
    requestHeaders: tx.requestHeaders,
    requestBodyB64: reqBody.toString("base64"),
    requestBodyIsText: isTextBody(tx.requestHeaders, reqBody),
    statusLine: tx.statusLine,
    responseHeaders: tx.responseHeaders,
    responseBodyB64: resBody.toString("base64"),
    responseBodyIsText: isTextBody(tx.responseHeaders, resBody),
  };
}

// Decompress a body per its Content-Encoding (br / gzip / deflate). Falls back to the raw bytes if
// the header is absent or decompression fails (e.g. a truncated capture).
function decodeBody(headers: ProxyHeader[], body: Buffer): Buffer {
  if (body.length === 0) return body;
  const encoding = headerValue(headers, "content-encoding").toLowerCase().trim();
  try {
    if (encoding === "br") return zlib.brotliDecompressSync(body);
    if (encoding === "gzip" || encoding === "x-gzip") return zlib.gunzipSync(body);
    if (encoding === "deflate") {
      try {
        return zlib.inflateSync(body);
      } catch {
        return zlib.inflateRawSync(body);
      }
    }
  } catch {
    return body;
  }
  return body;
}

export function headerValue(headers: ProxyHeader[], name: string): string {
  const lower = name.toLowerCase();
  for (const h of headers) if (h.name.toLowerCase() === lower) return h.value;
  return "";
}

function countParams(tx: StoredTransaction): number {
  const qIndex = tx.url.indexOf("?");
  const query = qIndex >= 0 ? tx.url.slice(qIndex + 1) : "";
  const queryCount = query ? query.split("&").filter(Boolean).length : 0;
  const ct = headerValue(tx.requestHeaders, "content-type");
  let bodyCount = 0;
  if (ct.includes("application/x-www-form-urlencoded") && tx.requestBody.length) {
    bodyCount = tx.requestBody.toString("utf8").split("&").filter(Boolean).length;
  }
  return queryCount + bodyCount;
}

function extensionOf(url: string): string {
  const pathPart = url.split("?")[0] ?? "";
  const last = pathPart.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  return dot > 0 ? last.slice(dot + 1) : "";
}

function parseTitle(body: Buffer, mimeType: string): string {
  if (!mimeType.includes("html")) return "";
  const match = /<title[^>]*>([^<]{0,200})<\/title>/i.exec(body.toString("utf8", 0, 65536));
  return match?.[1]?.trim() ?? "";
}

function isTextBody(headers: ProxyHeader[], body: Buffer): boolean {
  if (body.length === 0) return true;
  const ct = headerValue(headers, "content-type").toLowerCase();
  if (ct) {
    if (/text\/|json|xml|javascript|x-www-form-urlencoded|html|graphql/.test(ct)) return true;
    if (/image\/|audio\/|video\/|octet-stream|font\/|pdf|zip|protobuf/.test(ct)) return false;
  }
  // Sniff: treat as binary if it holds a NUL in the first 1KB.
  const slice = body.subarray(0, 1024);
  return !slice.includes(0);
}
