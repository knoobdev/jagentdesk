import http from "node:http";
import https from "node:https";
import tls from "node:tls";

// REST + SSE transport to one Argo CD server (spec 30, reference §1.1). Only the REST surface
// the web UI uses: no gRPC, no protobuf. TLS options are per instance (Skip TLS verify, a
// private CA, mTLS) and custom headers ride on every request (auth proxies in front of Argo CD).

export interface ArgoCdTransportOptions {
  baseUrl: string; // `https://argocd.example:443` or with a root path; no trailing slash
  tlsSkipVerify: boolean;
  caPem: string | null;
  clientCertPem: string | null;
  clientKeyPem: string | null;
  headers: Record<string, string>;
}

export type ArgoCdQuery = Record<string, string | number | boolean | string[] | undefined>;

export interface ArgoCdHttpRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string; // `/api/v1/...`
  query?: ArgoCdQuery;
  body?: unknown;
  token: string | null;
  timeoutMs?: number;
}

export interface ArgoCdHttpResponse {
  status: number;
  body: unknown;
  // Session token renewed by the server (`Set-Cookie: argocd.token=…`, reference §1.5).
  renewedToken: string | null;
}

const TLS_VERIFY_ERROR_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_GET_ISSUER_CERT",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_UNTRUSTED",
]);

/** Argo CD answered with a non-2xx status. `grpcCode` comes from the grpc-gateway error body. */
export class ArgoCdApiError extends Error {
  constructor(
    readonly status: number,
    readonly grpcCode: number | null,
    message: string,
  ) {
    super(message);
    this.name = "ArgoCdApiError";
  }
}

/** The server certificate failed verification. Carries what the UI shows to the user. */
export class ArgoCdTlsError extends Error {
  constructor(
    readonly reason: string,
    readonly fingerprintSha256: string | null,
  ) {
    super(`TLS certificate not trusted (${reason})`);
    this.name = "ArgoCdTlsError";
  }
}

/** The server could not be reached at all (DNS, refused, timeout). */
export class ArgoCdUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgoCdUnreachableError";
  }
}

export function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function buildUrl(baseUrl: string, path: string, query: ArgoCdQuery | undefined): URL {
  const url = new URL(baseUrl + path);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, item);
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function agentOptions(options: ArgoCdTransportOptions): https.RequestOptions {
  return {
    rejectUnauthorized: !options.tlsSkipVerify,
    ...(options.caPem ? { ca: options.caPem } : {}),
    ...(options.clientCertPem && options.clientKeyPem
      ? { cert: options.clientCertPem, key: options.clientKeyPem }
      : {}),
  };
}

// Joins Argo CD's split cookie (util/http/http.go splitCookie): a short token is
// `argocd.token=<jwt>`; a long one is `argocd.token=<n>:<chunk0>`, `argocd.token-1=<chunk1>`, ….
export function renewedTokenFromSetCookie(setCookie: string[] | undefined): string | null {
  if (!setCookie || setCookie.length === 0) return null;
  const values = new Map<string, string>();
  for (const header of setCookie) {
    const pair = header.split(";", 1)[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    values.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  const head = values.get("argocd.token");
  if (!head) return null;
  const chunked = /^(\d+):(.*)$/.exec(head);
  if (!chunked) return head;
  const count = Number(chunked[1]);
  let token = chunked[2] ?? "";
  for (let index = 1; index < count; index++) {
    const part = values.get(`argocd.token-${index}`);
    if (part === undefined) return null;
    token += part;
  }
  return token;
}

function parseErrorBody(status: number, raw: string): ArgoCdApiError {
  try {
    const parsed = JSON.parse(raw) as { message?: unknown; error?: unknown; code?: unknown };
    let message = raw;
    if (typeof parsed.message === "string" && parsed.message) message = parsed.message;
    else if (typeof parsed.error === "string") message = parsed.error;
    return new ArgoCdApiError(
      status,
      typeof parsed.code === "number" ? parsed.code : null,
      message,
    );
  } catch {
    return new ArgoCdApiError(status, null, raw.trim() || `HTTP ${status}`);
  }
}

async function readPeerFingerprint(
  url: URL,
  options: ArgoCdTransportOptions,
): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = tls.connect(
      {
        host: url.hostname,
        port: Number(url.port || 443),
        servername: url.hostname,
        rejectUnauthorized: false,
        ...(options.clientCertPem && options.clientKeyPem
          ? { cert: options.clientCertPem, key: options.clientKeyPem }
          : {}),
      },
      () => {
        const certificate = socket.getPeerCertificate();
        socket.end();
        resolve(certificate?.fingerprint256 ?? null);
      },
    );
    socket.setTimeout(5000, () => {
      socket.destroy();
      resolve(null);
    });
    socket.on("error", () => resolve(null));
  });
}

function classifyTransportError(error: NodeJS.ErrnoException, url: URL): Error {
  const code = error.code ?? "";
  if (TLS_VERIFY_ERROR_CODES.has(code)) return new ArgoCdTlsError(code, null);
  return new ArgoCdUnreachableError(`${url.host}: ${error.message}`);
}

interface RawRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  timeoutMs: number;
}

// A TLS failure carries the presented certificate's fingerprint (spec 30.2.3), read with a
// second, non-verifying handshake.
async function openRequest(
  options: ArgoCdTransportOptions,
  raw: RawRequest,
): Promise<http.IncomingMessage> {
  try {
    return await sendRequest(options, raw);
  } catch (error) {
    if (error instanceof ArgoCdTlsError && error.fingerprintSha256 === null) {
      throw new ArgoCdTlsError(error.reason, await readPeerFingerprint(raw.url, options));
    }
    throw error;
  }
}

function sendRequest(
  options: ArgoCdTransportOptions,
  raw: RawRequest,
): Promise<http.IncomingMessage> {
  const isHttps = raw.url.protocol === "https:";
  const transport = isHttps ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(
      raw.url,
      {
        method: raw.method,
        headers: raw.headers,
        ...(isHttps ? agentOptions(options) : {}),
      },
      resolve,
    );
    req.setTimeout(raw.timeoutMs, () => {
      req.destroy(new ArgoCdUnreachableError(`${raw.url.host}: timed out`));
    });
    req.on("error", (error: NodeJS.ErrnoException) => {
      reject(
        error instanceof ArgoCdUnreachableError ? error : classifyTransportError(error, raw.url),
      );
    });
    if (raw.body !== null) req.write(raw.body);
    req.end();
  });
}

function requestHeaders(
  options: ArgoCdTransportOptions,
  token: string | null,
  accept: string,
  hasBody: boolean,
): Record<string, string> {
  return {
    ...options.headers,
    Accept: accept,
    ...(hasBody ? { "Content-Type": "application/json" } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export async function argoCdRequest(
  options: ArgoCdTransportOptions,
  request: ArgoCdHttpRequest,
): Promise<ArgoCdHttpResponse> {
  const url = buildUrl(options.baseUrl, request.path, request.query);
  const body = request.body === undefined ? null : JSON.stringify(request.body);
  const response = await openRequest(options, {
    url,
    method: request.method,
    headers: requestHeaders(options, request.token, "application/json", body !== null),
    body,
    timeoutMs: request.timeoutMs ?? 30_000,
  });
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  const status = response.statusCode ?? 0;
  if (status < 200 || status >= 300) throw parseErrorBody(status, text);
  return {
    status,
    body: text ? (JSON.parse(text) as unknown) : {},
    renewedToken: renewedTokenFromSetCookie(response.headers["set-cookie"]),
  };
}

export interface ArgoCdStreamHandlers {
  onMessage(result: unknown): void;
  /** `error` is null when the server closed the stream cleanly. */
  onClose(error: Error | null): void;
}

export interface ArgoCdStreamRequest {
  path: string;
  query?: ArgoCdQuery;
  token: string | null;
  // No byte (data or `:` keepalive) for this long → the stream is treated as dead. Argo CD
  // sends a keepalive every 15 s, so 2 × 15 s.
  idleTimeoutMs?: number;
}

export interface ArgoCdStreamHandle {
  close(): void;
}

// Server-sent events from grpc-gateway (reference §1.5): each message is
// `data: {"result": …}` or `data: {"error": …}`, blank-line separated; `:` lines are keepalives.
export function openArgoCdStream(
  options: ArgoCdTransportOptions,
  request: ArgoCdStreamRequest,
  handlers: ArgoCdStreamHandlers,
): ArgoCdStreamHandle {
  const url = buildUrl(options.baseUrl, request.path, request.query);
  const idleTimeoutMs = request.idleTimeoutMs ?? 30_000;
  let closed = false;
  let activeResponse: http.IncomingMessage | null = null;
  let idleTimer: NodeJS.Timeout | null = null;

  function finish(error: Error | null): void {
    if (closed) return;
    closed = true;
    if (idleTimer) clearTimeout(idleTimer);
    activeResponse?.destroy();
    handlers.onClose(error);
  }

  function armIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => finish(new ArgoCdUnreachableError(`${url.host}: stream idle`)),
      idleTimeoutMs,
    );
  }

  function handleEvent(data: string): void {
    const parsed = JSON.parse(data) as { result?: unknown; error?: { message?: string } };
    if (parsed.error) {
      finish(new ArgoCdApiError(500, null, parsed.error.message ?? "stream error"));
      return;
    }
    handlers.onMessage(parsed.result);
  }

  async function consume(response: http.IncomingMessage): Promise<void> {
    if (closed) {
      response.destroy();
      return;
    }
    activeResponse = response;
    response.socket?.setTimeout(0);
    const status = response.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      const chunks: Buffer[] = [];
      for await (const chunk of response) chunks.push(chunk as Buffer);
      finish(parseErrorBody(status, Buffer.concat(chunks).toString("utf8")));
      return;
    }
    armIdleTimer();
    let buffer = "";
    let dataLines: string[] = [];
    response.setEncoding("utf8");
    for await (const chunk of response) {
      if (closed) return;
      armIdleTimer();
      buffer += chunk as string;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") {
          if (dataLines.length > 0) handleEvent(dataLines.join("\n"));
          dataLines = [];
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
        if (closed) return;
        newline = buffer.indexOf("\n");
      }
    }
    finish(null);
  }

  openRequest(options, {
    url,
    method: "GET",
    headers: requestHeaders(options, request.token, "text/event-stream", false),
    body: null,
    timeoutMs: 15_000,
  })
    .then(consume)
    .catch((error: Error) => finish(error));

  return {
    close() {
      if (closed) return;
      closed = true;
      if (idleTimer) clearTimeout(idleTimer);
      activeResponse?.destroy();
    },
  };
}

export interface AbsoluteRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface AbsoluteResponse {
  status: number;
  text: string;
}

/**
 * A request outside the Argo CD API (OIDC discovery and token endpoints, spec 30.2.1). The
 * instance's TLS settings apply only when the URL is on the Argo CD origin — a private CA must
 * not replace the system roots for a public IdP.
 */
export async function requestAbsolute(
  options: ArgoCdTransportOptions,
  request: AbsoluteRequest,
): Promise<AbsoluteResponse> {
  const url = new URL(request.url);
  const sameOrigin = url.origin === new URL(options.baseUrl).origin;
  const effective: ArgoCdTransportOptions = sameOrigin
    ? options
    : {
        ...options,
        caPem: null,
        clientCertPem: null,
        clientKeyPem: null,
        headers: {},
      };
  const response = await openRequest(effective, {
    url,
    method: request.method,
    headers: request.headers,
    body: request.body,
    timeoutMs: 30_000,
  });
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(chunk as Buffer);
  return { status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") };
}
