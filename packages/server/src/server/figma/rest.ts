import type pino from "pino";
import { type FigmaBudget } from "@jagentdesk/protocol/figma/rpc-schemas";
import type { FigmaRestClient, FigmaTier, FigmaTokenProvider } from "./context.js";
import { FigmaServiceError } from "./context.js";
import { unavailableTokens } from "./unavailable.js";

type RateLimitType = NonNullable<FigmaBudget["rateLimitType"]>;

// Every call to api.figma.com goes through here (spec 32.8, research §4). Base URL is fixed to
// https://api.figma.com; tests point it at a fake with JAGENTDESK_FIGMA_API_URL. The client keeps
// the per-connection tier budget (requests sent per tier in the last minute), honours 429
// Retry-After by blocking the tier until Figma says requests are allowed again — refusing without
// a network call while blocked — and never retries a 429 automatically. A 401 invalidates the
// cached token and retries exactly once with a fresh one. No header or body is ever logged.

export const FIGMA_API_BASE_URL = "https://api.figma.com";
export const FIGMA_API_URL_ENV = "JAGENTDESK_FIGMA_API_URL";

const TIERS: readonly FigmaTier[] = ["1", "2", "3"];
const BUDGET_WINDOW_MS = 60_000;
const DEFAULT_RETRY_AFTER_S = 60;
const REQUEST_TIMEOUT_MS = 30_000;

const STATUS_CODES: Record<number, string> = {
  400: "invalid_input",
  401: "auth_failed",
  403: "forbidden",
  404: "not_found",
  413: "too_large",
  422: "invalid_input",
};

interface TierBudget {
  /** Timestamps (ms) of requests sent to Figma for this tier; the last-minute window is filtered on read. */
  sentAt: number[];
  blockedUntil_ms: number | null;
}

interface ConnectionBudget {
  tiers: Map<FigmaTier, TierBudget>;
  planTier: string | null;
  rateLimitType: RateLimitType | null;
  upgradeUrl: string | null;
}

export interface FigmaRestClientOptions {
  logger: pino.Logger;
  /** Resolved per request so the tokens part can be swapped without rebuilding the client. */
  tokens?: () => FigmaTokenProvider;
  baseUrl?: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

function parseRetryAfterMs(header: string | null): number {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0
    ? Math.round(seconds * 1000)
    : DEFAULT_RETRY_AFTER_S * 1000;
}

export class HttpFigmaRestClient implements FigmaRestClient {
  private readonly logger: pino.Logger;
  private tokens: () => FigmaTokenProvider;
  private readonly baseUrl: string;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly budgets = new Map<string, ConnectionBudget>();

  constructor(options: FigmaRestClientOptions) {
    this.logger = options.logger.child({ module: "figma-rest" });
    this.tokens = options.tokens ?? (() => unavailableTokens);
    this.baseUrl = (
      options.baseUrl ??
      process.env[FIGMA_API_URL_ENV] ??
      FIGMA_API_BASE_URL
    ).replace(/\/+$/, "");
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Points the client at the live context's token provider (set once by createFigmaService). */
  bindTokens(getTokens: () => FigmaTokenProvider): void {
    this.tokens = getTokens;
  }

  async getJson<T>(input: {
    connectionId: string;
    path: string;
    query?: Record<string, string | number | boolean | undefined>;
    tier: FigmaTier;
  }): Promise<T> {
    return this.request<T>(
      input.connectionId,
      input.path,
      input.query,
      "GET",
      undefined,
      input.tier,
    );
  }

  async sendJson<T>(input: {
    connectionId: string;
    method: "POST" | "PUT" | "DELETE";
    path: string;
    body?: unknown;
    tier: FigmaTier;
  }): Promise<T> {
    return this.request<T>(
      input.connectionId,
      input.path,
      undefined,
      input.method,
      input.body,
      input.tier,
    );
  }

  /** Downloads a Figma-returned URL (S3 render, image fill). Never authenticated. */
  async getBytes(url: string): Promise<{ mimeType: string; data: Buffer }> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      throw this.networkError(error);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new FigmaServiceError(
        "network",
        `Could not download ${new URL(url).pathname}: Figma storage answered ${response.status}.`,
      );
    }
    return {
      mimeType: response.headers.get("content-type") ?? "application/octet-stream",
      data: Buffer.from(await response.arrayBuffer()),
    };
  }

  budget(connectionId: string): FigmaBudget {
    const now = this.now();
    const state = this.budgets.get(connectionId);
    return {
      connectionId,
      tiers: TIERS.map((tier) => {
        const tierBudget = state?.tiers.get(tier);
        const blocked = tierBudget?.blockedUntil_ms ?? null;
        return {
          tier,
          usedLastMinute: this.recentSends(tierBudget, now),
          blockedUntil_ms: blocked !== null && blocked > now ? blocked : null,
        };
      }),
      planTier: state?.planTier ?? null,
      rateLimitType: state?.rateLimitType ?? null,
      upgradeUrl: state?.upgradeUrl ?? null,
    };
  }

  private async request<T>(
    connectionId: string,
    path: string,
    query: Record<string, string | number | boolean | undefined> | undefined,
    method: "GET" | "POST" | "PUT" | "DELETE",
    body: unknown,
    tier: FigmaTier,
  ): Promise<T> {
    const now = this.now();
    const state = this.stateFor(connectionId);
    const tierBudget = this.tierBudgetFor(state, tier);
    if (tierBudget.blockedUntil_ms !== null) {
      if (tierBudget.blockedUntil_ms > now) {
        throw this.rateLimitedError(state, tierBudget.blockedUntil_ms);
      }
      tierBudget.blockedUntil_ms = null;
    }

    const url = this.buildUrl(path, query);
    tierBudget.sentAt.push(now);
    let response = await this.fetchAuthorized(url, method, body, connectionId);

    if (response.status === 401) {
      // One refresh-and-retry: the token provider drops its cached token and mints a fresh one.
      await response.body?.cancel();
      this.tokens().invalidate(connectionId);
      tierBudget.sentAt.push(this.now());
      response = await this.fetchAuthorized(url, method, body, connectionId);
    }

    if (response.status === 429) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      tierBudget.blockedUntil_ms = this.now() + retryAfterMs;
      state.planTier = response.headers.get("x-figma-plan-tier") ?? state.planTier;
      state.rateLimitType = readRateLimitType(response.headers) ?? state.rateLimitType;
      state.upgradeUrl = response.headers.get("x-figma-upgrade-link") ?? state.upgradeUrl;
      const detail = await this.errorDetail(response);
      throw this.rateLimitedError(state, tierBudget.blockedUntil_ms, detail);
    }

    if (!response.ok) {
      const detail = await this.errorDetail(response);
      const code =
        STATUS_CODES[response.status] ?? (response.status >= 500 ? "network" : "figma_error");
      this.logger.info({ method, path, status: response.status }, "figma request failed");
      throw new FigmaServiceError(
        code,
        detail ?? `Figma answered ${response.status} for ${method} ${path}.`,
      );
    }

    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new FigmaServiceError("figma_error", `Figma returned a non-JSON body for ${path}.`);
    }
  }

  private async fetchAuthorized(
    url: string,
    method: string,
    body: unknown,
    connectionId: string,
  ): Promise<Response> {
    const token = await this.tokens().accessToken(connectionId);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    let payload: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    try {
      return await this.fetchImpl(url, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw this.networkError(error);
    }
  }

  private buildUrl(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): string {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async errorDetail(response: Response): Promise<string | null> {
    try {
      const parsed = JSON.parse(await response.text()) as { err?: unknown; message?: unknown };
      for (const value of [parsed.err, parsed.message]) {
        if (typeof value === "string" && value.length > 0) return value;
      }
    } catch {
      // Non-JSON error pages carry no usable detail.
    }
    return null;
  }

  private rateLimitedError(
    state: ConnectionBudget,
    blockedUntil_ms: number,
    detail?: string | null,
  ): FigmaServiceError {
    const plan = state.planTier ? ` (your plan: ${state.planTier})` : "";
    return new FigmaServiceError(
      "rate_limited",
      detail ?? `Figma limited requests for this account${plan}. Try again later.`,
      {
        retryAt_ms: blockedUntil_ms,
        planTier: state.planTier ?? undefined,
        rateLimitType: state.rateLimitType ?? undefined,
        upgradeUrl: state.upgradeUrl ?? undefined,
      },
    );
  }

  private networkError(error: unknown): FigmaServiceError {
    const message = error instanceof Error ? error.message : String(error);
    return new FigmaServiceError("network", `Could not reach Figma: ${message}`);
  }

  private recentSends(tierBudget: TierBudget | undefined, now: number): number {
    if (!tierBudget) return 0;
    const cutoff = now - BUDGET_WINDOW_MS;
    tierBudget.sentAt = tierBudget.sentAt.filter((sent) => sent > cutoff);
    return tierBudget.sentAt.length;
  }

  private stateFor(connectionId: string): ConnectionBudget {
    let state = this.budgets.get(connectionId);
    if (!state) {
      state = { tiers: new Map(), planTier: null, rateLimitType: null, upgradeUrl: null };
      this.budgets.set(connectionId, state);
    }
    return state;
  }

  private tierBudgetFor(state: ConnectionBudget, tier: FigmaTier): TierBudget {
    let budget = state.tiers.get(tier);
    if (!budget) {
      budget = { sentAt: [], blockedUntil_ms: null };
      state.tiers.set(tier, budget);
    }
    return budget;
  }
}

function readRateLimitType(headers: Headers): RateLimitType | null {
  const value = headers.get("x-figma-rate-limit-type");
  return value === "low" || value === "high" ? value : null;
}
