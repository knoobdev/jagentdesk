import { createHash, randomBytes } from "node:crypto";
import type pino from "pino";
import type { FigmaConnection, FigmaPush } from "@jagentdesk/protocol/figma/rpc-schemas";
import type { SecretStore } from "../database/secret-store.js";
import type { FigmaContext, FigmaTokenProvider } from "./context.js";
import { FigmaServiceError } from "./context.js";
import type { FigmaSessionInfo } from "./handlers/types.js";

// Figma OAuth 2.0 with a private app the user registers themselves (spec 32.2, ADR-0035 §1).
// The client id and secret live only in ctx.secrets; no response payload carries a secret.
// The browser step runs on a client — the desktop loopback listener or the user pasting the
// final URL — and the code is exchanged IMMEDIATELY (Figma's codes die after 30 seconds) with
// the client secret over HTTP Basic and a PKCE S256 verifier (figma-integration.md §2).
//
// This class is the daemon's ONE token manager (FigmaContext.tokens): one in-flight refresh per
// connection, the rotated tokens persisted to the secret store before anything uses them, and
// `invalid_grant` parking the connection in `needs_reauth`. It never logs a token or secret.

export interface FigmaEndpoints {
  /** Where the user's browser opens `/oauth`. */
  authUrl: string;
  /** api.figma.com: `/v1/oauth/token`, `/v1/oauth/refresh`, `/v1/me`. */
  apiUrl: string;
}

export const FIGMA_ENDPOINTS: FigmaEndpoints = {
  authUrl: "https://www.figma.com",
  apiUrl: "https://api.figma.com",
};

/** Figma endpoints, overridable for a test double (never for a proxy) — like Jira's env override. */
export function figmaEndpointsFromEnv(env: NodeJS.ProcessEnv): FigmaEndpoints {
  return {
    authUrl: env.JAGENTDESK_FIGMA_AUTH_URL ?? FIGMA_ENDPOINTS.authUrl,
    apiUrl: env.JAGENTDESK_FIGMA_API_URL ?? FIGMA_ENDPOINTS.apiUrl,
  };
}

// The scopes spec 32.2 requires from the user's private app. `file_variables:*` is Enterprise-only
// and variables go through Figma Link, so it is not requested.
// Verified against Figma's OAuth-apps docs (2026-11): the `scope` parameter accepts this list
// space- OR comma-separated (space is what we send), and the requested scopes must be a SUBSET of
// the scopes enabled on the app in the Figma console — a scope the app has not enabled is dropped
// silently at consent. So a token can pass `GET /v1/me` yet 403 on `/v1/files/...`: the guide
// (packages/app/src/figma/connect) lists this exact array for the user to tick, and its test and
// the assertion below pin both copies to spec 32.2 — the guide must never drift from this request.
export const FIGMA_OAUTH_SCOPES = [
  "current_user:read",
  "file_content:read",
  "file_metadata:read",
  "file_versions:read",
  "file_comments:read",
  "file_comments:write",
  "library_content:read",
  "file_dev_resources:read",
];

// The callback the desktop registers (32.2). Paste mode uses the same URL: the user copies the
// address the browser lands on.
export const FIGMA_LOOPBACK_REDIRECT_URI = "http://127.0.0.1:8766/figma/callback";

const ATTEMPT_TTL_MS = 10 * 60_000;
const REFRESH_MARGIN_MS = 5 * 60_000;
const DEFAULT_EXPIRES_IN_S = 90 * 24 * 60 * 60;

export function figmaClientIdKey(connectionId: string): string {
  return `figma/${connectionId}/client_id`;
}
export function figmaClientSecretKey(connectionId: string): string {
  return `figma/${connectionId}/client_secret`;
}
export function figmaTokensKey(connectionId: string): string {
  return `figma/${connectionId}/tokens`;
}

/** Every secret key one connection owns — used by `figma.connections.remove`. */
export function figmaSecretKeys(connectionId: string): string[] {
  return [
    figmaClientIdKey(connectionId),
    figmaClientSecretKey(connectionId),
    figmaTokensKey(connectionId),
  ];
}

interface StoredFigmaTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt_ms: number;
}

interface PendingAttempt {
  attemptId: string;
  state: string;
  codeVerifier: string;
  clientId: string;
  clientSecret: string;
  redirect: "loopback" | "paste";
  expiresAt_ms: number;
}

export interface FigmaOAuthBegun {
  attemptId: string;
  authorizeUrl: string;
  redirectUri: string;
}

export interface FigmaOAuthDelegateResult {
  attemptId: string | null;
  desktopAvailable: boolean;
}

export function pkceChallengeS256(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}

/** Accept a string or numeric id so a /v1/me shape change cannot silently break sign-in. */
function readStringId(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

/** `code` and `state` from the URL the browser landed on (paste fallback, 32.2). */
export function parseFigmaCallbackUrl(callbackUrl: string): { code: string; state: string } {
  let url: URL;
  try {
    url = new URL(callbackUrl.trim());
  } catch {
    throw new FigmaServiceError("invalid_input", "That is not a URL.");
  }
  const error = url.searchParams.get("error");
  if (error) {
    const description = url.searchParams.get("error_description") ?? error;
    throw new FigmaServiceError("auth_failed", `Figma sign-in was refused: ${description}`);
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    throw new FigmaServiceError(
      "invalid_input",
      "The URL has no code and state. Copy the address after approving access.",
    );
  }
  return { code, state };
}

interface TokenResponseBody {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
  err?: unknown;
  error_description?: unknown;
  message?: unknown;
  // /v1/me fields — readAccount parses its response through the same shape.
  id?: unknown;
  handle?: unknown;
  email?: unknown;
}

export interface FigmaOAuthOptions {
  secrets: SecretStore;
  logger: pino.Logger;
  endpoints?: FigmaEndpoints;
  fetch?: typeof fetch;
  now?: () => number;
}

export class FigmaOAuth implements FigmaTokenProvider {
  private readonly secrets: SecretStore;
  private readonly logger: pino.Logger;
  private readonly endpoints: FigmaEndpoints;
  private readonly fetchImpl: typeof fetch;
  private readonly nowImpl: (() => number) | null;
  // The service context, attached by the connections handlers on first use; provides store,
  // push and the daemon clock. `accessToken`/`invalidate` have no ctx of their own (fixed
  // FigmaTokenProvider signature), so they run from this.
  private context: FigmaContext | null = null;
  private readonly pending = new Map<string, PendingAttempt>();
  private readonly access = new Map<string, StoredFigmaTokens>();
  private readonly refreshing = new Map<string, Promise<string>>();
  private readonly forceRefresh = new Set<string>();
  private readonly loopbackSessions = new Set<string>();

  constructor(options: FigmaOAuthOptions) {
    this.secrets = options.secrets;
    this.logger = options.logger.child({ module: "figma-oauth" });
    this.endpoints = options.endpoints ?? figmaEndpointsFromEnv(process.env);
    this.fetchImpl = options.fetch ?? fetch;
    this.nowImpl = options.now ?? null;
  }

  /** Connections handlers bind the live service context before every call. */
  attach(ctx: FigmaContext): void {
    this.context = ctx;
  }

  /** Remember which sessions belong to a desktop that can serve the 8766 callback (32.2). */
  trackSession(session: FigmaSessionInfo): void {
    if (session.canRunLoopback) this.loopbackSessions.add(session.sessionKey);
  }

  /** Drop all cached state for a removed connection (secrets are deleted by the caller). */
  forgetCache(connectionId: string): void {
    this.access.delete(connectionId);
    this.refreshing.delete(connectionId);
    this.forceRefresh.delete(connectionId);
  }

  private now(): number {
    return (this.context?.now ?? this.nowImpl ?? Date.now)();
  }

  begin(
    ctx: FigmaContext,
    input: { clientId: string; clientSecret: string; redirect: "loopback" | "paste" },
  ): FigmaOAuthBegun {
    this.attach(ctx);
    this.prune();
    const clientId = input.clientId.trim();
    const clientSecret = input.clientSecret.trim();
    if (!clientId || !clientSecret) {
      throw new FigmaServiceError("invalid_input", "Client ID and secret are required.");
    }
    const state = randomBytes(24).toString("base64url");
    const codeVerifier = randomBytes(48).toString("base64url");
    const attemptId = `fga_${randomBytes(9).toString("base64url")}`;
    const expiresAt_ms = this.now() + ATTEMPT_TTL_MS;
    this.pending.set(attemptId, {
      attemptId,
      state,
      codeVerifier,
      clientId,
      clientSecret,
      redirect: input.redirect,
      expiresAt_ms,
    });
    const url = new URL(`${this.endpoints.authUrl}/oauth`);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", FIGMA_LOOPBACK_REDIRECT_URI);
    url.searchParams.set("scope", FIGMA_OAUTH_SCOPES.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", pkceChallengeS256(codeVerifier));
    url.searchParams.set("code_challenge_method", "S256");
    return { attemptId, authorizeUrl: url.toString(), redirectUri: FIGMA_LOOPBACK_REDIRECT_URI };
  }

  async complete(
    ctx: FigmaContext,
    input: { attemptId: string; code?: string; state?: string; pastedUrl?: string },
  ): Promise<FigmaConnection> {
    this.attach(ctx);
    this.prune();
    const attempt = this.pending.get(input.attemptId);
    if (!attempt) {
      throw new FigmaServiceError("invalid_input", "This sign-in expired. Start again.");
    }
    let { code, state } = input;
    if (input.pastedUrl) {
      const parsed = parseFigmaCallbackUrl(input.pastedUrl);
      code = parsed.code;
      state = parsed.state;
    }
    if (!code || !state) {
      throw new FigmaServiceError(
        "invalid_input",
        "The sign-in returned no code and state. Paste the full URL instead.",
      );
    }
    if (state !== attempt.state) {
      throw new FigmaServiceError(
        "invalid_input",
        "That sign-in belongs to a different attempt. Start again.",
      );
    }
    this.pending.delete(input.attemptId);
    // The code lives 30 seconds: exchange it before anything else touches the store or secrets.
    const tokens = await this.requestToken(attempt.clientId, attempt.clientSecret, {
      path: "/v1/oauth/token",
      form: {
        grant_type: "authorization_code",
        code,
        redirect_uri: FIGMA_LOOPBACK_REDIRECT_URI,
        code_verifier: attempt.codeVerifier,
      },
    });
    const account = await this.readAccount(tokens.accessToken);
    const connection: FigmaConnection = {
      id: `fgc_${randomBytes(12).toString("base64url")}`,
      account,
      authState: "connected",
      tokenExpiresAt_ms: tokens.expiresAt_ms,
      createdAt_ms: this.now(),
    };
    await this.saveTokens(connection.id, attempt.clientId, attempt.clientSecret, tokens);
    await ctx.store.saveConnection(connection);
    this.logger.info({ connectionId: connection.id }, "figma oauth connection added");
    return connection;
  }

  /**
   * "Sign in on a desktop" (32.2): a mobile asks the daemon to hand the browser step to a
   * paired desktop. The delegation push reaches every session; only desktop clients run it.
   */
  delegate(
    ctx: FigmaContext,
    input: { clientId: string; clientSecret: string },
    session: FigmaSessionInfo,
  ): FigmaOAuthDelegateResult {
    this.attach(ctx);
    this.trackSession(session);
    const desktopAvailable = session.canRunLoopback || this.loopbackSessions.size > 0;
    if (!desktopAvailable) return { attemptId: null, desktopAvailable: false };
    const begun = this.begin(ctx, { ...input, redirect: "loopback" });
    ctx.push({
      type: "figma.oauth.delegation",
      attemptId: begun.attemptId,
      authorizeUrl: begun.authorizeUrl,
      redirectUri: begun.redirectUri,
    } satisfies FigmaPush);
    return { attemptId: begun.attemptId, desktopAvailable: true };
  }

  /** Valid access token, refreshed single-flight when within 5 minutes of expiry. */
  async accessToken(connectionId: string): Promise<string> {
    const cached = this.access.get(connectionId) ?? (await this.loadTokens(connectionId));
    if (cached) this.access.set(connectionId, cached);
    const expiresSoon = !cached || cached.expiresAt_ms - REFRESH_MARGIN_MS <= this.now();
    if (!expiresSoon && !this.forceRefresh.has(connectionId)) return cached!.accessToken;
    return this.refresh(connectionId);
  }

  /** The REST client calls this after a 401: the next `accessToken` refreshes unconditionally. */
  invalidate(connectionId: string): void {
    this.access.delete(connectionId);
    this.forceRefresh.add(connectionId);
  }

  async testConnection(ctx: FigmaContext, connectionId: string): Promise<FigmaConnection | null> {
    this.attach(ctx);
    const existing = await ctx.store.getConnection(connectionId);
    if (!existing) {
      throw new FigmaServiceError("not_found", "No such Figma connection.");
    }
    try {
      const token = await this.accessToken(connectionId);
      const account = await this.readAccount(token);
      return this.patchConnection(ctx, existing, {
        account,
        authState: "connected",
        lastError: undefined,
      });
    } catch (error) {
      if (
        error instanceof FigmaServiceError &&
        (error.code === "needs_reauth" || error.code === "auth_failed")
      ) {
        return this.patchConnection(ctx, existing, {
          authState: "needs_reauth",
          lastError: error.message,
        });
      }
      throw error;
    }
  }

  private async patchConnection(
    ctx: FigmaContext,
    connection: FigmaConnection,
    patch: Partial<FigmaConnection>,
  ): Promise<FigmaConnection> {
    const updated: FigmaConnection = { ...connection, ...patch };
    if (patch.lastError === undefined && "lastError" in patch) delete updated.lastError;
    await ctx.store.saveConnection(updated);
    return updated;
  }

  private refresh(connectionId: string): Promise<string> {
    const inFlight = this.refreshing.get(connectionId);
    if (inFlight) return inFlight;
    const run = this.runRefresh(connectionId).finally(() => {
      this.refreshing.delete(connectionId);
    });
    this.refreshing.set(connectionId, run);
    return run;
  }

  private async runRefresh(connectionId: string): Promise<string> {
    const stored = await this.loadTokens(connectionId);
    const clientId = await this.secrets.get(figmaClientIdKey(connectionId));
    const clientSecret = await this.secrets.get(figmaClientSecretKey(connectionId));
    if (!stored?.refreshToken || !clientId || !clientSecret) {
      await this.markNeedsReauth(connectionId, "Sign in to Figma again.");
      throw new FigmaServiceError("needs_reauth", "Sign in to Figma again.");
    }
    let tokens: StoredFigmaTokens;
    try {
      // Figma's refresh response does not return a new refresh token — the old one stays valid
      // ("can be reused as many times as necessary", figma-integration.md §2.4).
      const response = await this.requestToken(clientId, clientSecret, {
        path: "/v1/oauth/refresh",
        form: { grant_type: "refresh_token", refresh_token: stored.refreshToken },
      });
      tokens = { ...response, refreshToken: response.refreshToken || stored.refreshToken };
    } catch (error) {
      if (error instanceof FigmaServiceError && error.code === "needs_reauth") {
        await this.markNeedsReauth(connectionId, error.message);
      }
      throw error;
    }
    // Persist before use: Figma kills the old access token the moment a refresh succeeds, so a
    // crash between here and the next request must not resurrect a dead token.
    await this.secrets.set(figmaTokensKey(connectionId), JSON.stringify(tokens));
    this.access.set(connectionId, tokens);
    this.forceRefresh.delete(connectionId);
    const ctx = this.context;
    if (ctx) {
      const connection = await ctx.store.getConnection(connectionId);
      if (connection) {
        await this.patchConnection(ctx, connection, {
          authState: "connected",
          tokenExpiresAt_ms: tokens.expiresAt_ms,
          lastError: undefined,
        });
      }
    }
    this.logger.info({ connectionId }, "figma oauth token refreshed");
    return tokens.accessToken;
  }

  private async markNeedsReauth(connectionId: string, message: string): Promise<void> {
    this.access.delete(connectionId);
    this.forceRefresh.delete(connectionId);
    const ctx = this.context;
    if (ctx) {
      try {
        const connection = await ctx.store.getConnection(connectionId);
        if (connection) {
          await this.patchConnection(ctx, connection, {
            authState: "needs_reauth",
            lastError: message,
          });
        }
      } catch (error) {
        this.logger.warn({ err: error, connectionId }, "figma needs_reauth state not persisted");
      }
    }
    this.logger.warn({ connectionId }, "figma connection needs re-authentication");
  }

  /** POST an x-www-form-urlencoded body with the client secret over HTTP Basic (never in the body). */
  private async requestToken(
    clientId: string,
    clientSecret: string,
    input: { path: string; form: Record<string, string> },
  ): Promise<StoredFigmaTokens> {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const response = await this.postForm(`${this.endpoints.apiUrl}${input.path}`, input.form, {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    });
    if (!response.ok) throw await this.tokenEndpointFailure(response);
    const parsed = await this.readJsonBody(response);
    const accessToken = typeof parsed?.access_token === "string" ? parsed.access_token : "";
    if (!accessToken) {
      throw new FigmaServiceError("figma_error", "Figma did not return an access token.");
    }
    const expiresIn =
      typeof parsed?.expires_in === "number" && parsed.expires_in > 0
        ? parsed.expires_in
        : DEFAULT_EXPIRES_IN_S;
    return {
      accessToken,
      refreshToken: typeof parsed?.refresh_token === "string" ? parsed.refresh_token : "",
      expiresAt_ms: this.now() + expiresIn * 1000,
    };
  }

  private async postForm(
    url: string,
    form: Record<string, string>,
    extraHeaders: Record<string, string>,
  ): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        method: "POST",
        headers: { Accept: "application/json", ...extraHeaders },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new FigmaServiceError(
        "network",
        `Could not reach Figma: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** invalid_grant/403 parks the connection; 401 is a refused sign-in; anything else is a Figma fault. */
  private async tokenEndpointFailure(response: Response): Promise<FigmaServiceError> {
    const parsed = await this.readJsonBody(response);
    const error = String(parsed?.error ?? parsed?.err ?? "");
    const description =
      (typeof parsed?.error_description === "string" && parsed.error_description) ||
      (typeof parsed?.message === "string" && parsed.message) ||
      null;
    if (error === "invalid_grant" || response.status === 403) {
      return new FigmaServiceError("needs_reauth", description ?? "Figma refused the token.");
    }
    return new FigmaServiceError(
      response.status === 401 ? "auth_failed" : "figma_error",
      description ?? `Figma token endpoint responded ${response.status}.`,
    );
  }

  /** GET /v1/me — confirms the account after a sign-in or a connection test (32.2). */
  private async readAccount(accessToken: string): Promise<FigmaConnection["account"]> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.endpoints.apiUrl}/v1/me`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new FigmaServiceError(
        "network",
        `Could not reach Figma: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new FigmaServiceError("needs_reauth", "Figma rejected this sign-in. Sign in again.");
    }
    if (!response.ok) {
      throw new FigmaServiceError(
        "figma_error",
        `Figma account lookup failed (${response.status}).`,
      );
    }
    const me = await this.readJsonBody(response);
    const figmaUserId = readStringId(me?.id);
    const handle = typeof me?.handle === "string" ? me.handle : "";
    if (!figmaUserId || !handle) {
      throw new FigmaServiceError("figma_error", "Figma did not return your account.");
    }
    return {
      figmaUserId,
      handle,
      email: typeof me?.email === "string" ? me.email : null,
    };
  }

  private async readJsonBody(response: Response): Promise<TokenResponseBody | null> {
    try {
      return (await response.json()) as TokenResponseBody;
    } catch {
      return null;
    }
  }

  private async loadTokens(connectionId: string): Promise<StoredFigmaTokens | null> {
    const raw = await this.secrets.get(figmaTokensKey(connectionId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as StoredFigmaTokens;
      if (
        typeof parsed.accessToken === "string" &&
        parsed.accessToken &&
        typeof parsed.expiresAt_ms === "number"
      ) {
        return {
          accessToken: parsed.accessToken,
          refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken : "",
          expiresAt_ms: parsed.expiresAt_ms,
        };
      }
    } catch {
      /* fall through: a corrupt entry means sign-in again */
    }
    return null;
  }

  private async saveTokens(
    connectionId: string,
    clientId: string,
    clientSecret: string,
    tokens: StoredFigmaTokens,
  ): Promise<void> {
    await this.secrets.set(figmaClientIdKey(connectionId), clientId);
    await this.secrets.set(figmaClientSecretKey(connectionId), clientSecret);
    await this.secrets.set(figmaTokensKey(connectionId), JSON.stringify(tokens));
    this.access.set(connectionId, tokens);
  }

  private prune(): void {
    const now = this.now();
    for (const [attemptId, attempt] of this.pending) {
      if (attempt.expiresAt_ms < now) this.pending.delete(attemptId);
    }
  }
}
