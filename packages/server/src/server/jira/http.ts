import type pino from "pino";
import type { JiraCredentialManager } from "./credentials.js";
import { JiraApiError, jiraErrorFromResponse } from "./errors.js";
import type { JiraStorage, StoredJiraConnection } from "./storage.js";

// Every request to a Jira site goes through here: credentials from the daemon-wide manager, one
// refresh-and-retry on a 401 for OAuth, Retry-After honored for idempotent reads on a 429
// (spec reference §2.6), and no header or body ever logged.

export type QueryValue = string | number | boolean | undefined | null | readonly string[];

export interface JiraRequest {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  form?: FormData;
}

export interface JiraBytes {
  bytes: Buffer;
  contentType: string;
}

const MAX_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;

function buildUrl(baseUrl: string, path: string, query: JiraRequest["query"]): string {
  const url = new URL(path.startsWith("http") ? path : `${baseUrl}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    // Arrays repeat the parameter (OpenAPI form/explode), e.g. `reconcileIssues=1&reconcileIssues=2`.
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item);
    else url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function retryDelayMs(response: Response, attempt: number): number {
  const header = Number(response.headers.get("retry-after"));
  const base = Number.isFinite(header) && header > 0 ? header * 1000 : 2 ** attempt * 1000;
  return Math.min(MAX_RETRY_DELAY_MS, base);
}

export interface JiraHttpOptions {
  credentials: JiraCredentialManager;
  storage: JiraStorage;
  logger: pino.Logger;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class JiraHttp {
  private readonly credentials: JiraCredentialManager;
  private readonly storage: JiraStorage;
  private readonly logger: pino.Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: JiraHttpOptions) {
    this.credentials = options.credentials;
    this.storage = options.storage;
    this.logger = options.logger.child({ module: "jira-http" });
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async json<T>(connection: StoredJiraConnection, request: JiraRequest): Promise<T> {
    const response = await this.send(connection, request);
    const text = await response.text();
    if (text.length === 0) return undefined as T;
    return JSON.parse(text) as T;
  }

  /** Raw bytes (attachments). `url` may be absolute but must stay on the connection's origin. */
  async bytes(
    connection: StoredJiraConnection,
    request: JiraRequest,
    maxBytes: number,
  ): Promise<JiraBytes> {
    // Binary endpoints answer `Accept: application/json` with an error (Cloud attachment content
    // and thumbnail refuse it); ask for any type.
    const response = await this.send(connection, request, "*/*");
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel();
      throw new JiraApiError({
        code: "too_large",
        message: `The file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`,
      });
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) {
      throw new JiraApiError({
        code: "too_large",
        message: `The file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`,
      });
    }
    return {
      bytes,
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  private async send(
    connection: StoredJiraConnection,
    request: JiraRequest,
    accept = "application/json",
  ): Promise<Response> {
    let auth = await this.credentials.auth(connection);
    const method = request.method ?? "GET";
    const url = buildUrl(auth.baseUrl, request.path, request.query);
    if (new URL(url).origin !== new URL(auth.baseUrl).origin) {
      // Credentials are only ever sent to the connection's own site.
      throw new JiraApiError({ code: "invalid_input", message: "URL is outside the Jira site." });
    }
    let refreshed = false;
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.fetchOnce(url, method, auth.authorization, request, accept);
      if (response.ok) return response;
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        const next = await this.credentials.afterUnauthorized(connection, auth.authorization);
        if (next) {
          await response.body?.cancel();
          auth = next;
          continue;
        }
      }
      if (response.status === 429 && method === "GET" && attempt < MAX_RETRIES) {
        const delay = retryDelayMs(response, attempt);
        await response.body?.cancel();
        this.logger.warn({ connectionId: connection.id, delay }, "jira rate limited; retrying");
        await this.sleep(delay);
        continue;
      }
      const error = jiraErrorFromResponse(response.status, await response.text());
      if (response.status === 401) await this.markAuthFailed(connection, error);
      this.logger.info(
        { connectionId: connection.id, method, path: request.path, status: response.status },
        "jira request failed",
      );
      throw error;
    }
  }

  private async fetchOnce(
    url: string,
    method: string,
    authorization: string,
    request: JiraRequest,
    accept: string,
  ): Promise<Response> {
    const headers: Record<string, string> = { Authorization: authorization, Accept: accept };
    let body: BodyInit | undefined;
    if (request.form) {
      headers["X-Atlassian-Token"] = "no-check";
      body = request.form;
    } else if (request.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(request.body);
    }
    try {
      return await this.fetchImpl(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new JiraApiError({
        code: "network",
        message: `Could not reach Jira: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  private async markAuthFailed(
    connection: StoredJiraConnection,
    error: JiraApiError,
  ): Promise<void> {
    await this.storage.update(connection.id, {
      authState: connection.method === "oauth" ? "needs_reauth" : "error",
      lastError: error.message,
    });
  }
}
