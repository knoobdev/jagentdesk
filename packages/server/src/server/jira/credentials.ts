import type pino from "pino";
import type { SecretStore } from "../database/secret-store.js";
import { JiraApiError } from "./errors.js";
import type { JiraStorage, StoredJiraConnection } from "./storage.js";

// The one credential owner for every Jira connection in the daemon (ADR-0034 §4). Sessions,
// pollers and agent tools all go through the single instance created in bootstrap, so:
//  - an OAuth refresh runs at most once at a time per connection (single-flight), even when many
//    requests find the access token expired together;
//  - the rotated refresh token is persisted (FileSecretStore: atomic temp+rename, serialized
//    writes) before the new access token is used — Atlassian invalidates the old refresh token;
//  - access tokens stay in memory only.
// Nothing here logs a token, a client secret or an Authorization header.

export interface AtlassianEndpoints {
  /** Authorization server: `/authorize`, `/oauth/token`. */
  authUrl: string;
  /** API gateway: `/oauth/token/accessible-resources`, `/ex/jira/<cloudId>`. */
  apiUrl: string;
}

export const ATLASSIAN_ENDPOINTS: AtlassianEndpoints = {
  authUrl: "https://auth.atlassian.com",
  apiUrl: "https://api.atlassian.com",
};

/** Atlassian endpoints, overridable for an enterprise egress proxy or a test double. */
export function atlassianEndpointsFromEnv(env: NodeJS.ProcessEnv): AtlassianEndpoints {
  return {
    authUrl: env.JAGENTDESK_JIRA_AUTH_URL ?? ATLASSIAN_ENDPOINTS.authUrl,
    apiUrl: env.JAGENTDESK_JIRA_API_URL ?? ATLASSIAN_ENDPOINTS.apiUrl,
  };
}

export interface JiraAuth {
  baseUrl: string;
  authorization: string;
}

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt_ms: number;
}

const REFRESH_MARGIN_MS = 60_000;

export function tokenSecretKey(connectionId: string): string {
  return `jira.token.${connectionId}`;
}
export function refreshSecretKey(connectionId: string): string {
  return `jira.oauth.refresh.${connectionId}`;
}
export function clientSecretKey(connectionId: string): string {
  return `jira.oauth.client_secret.${connectionId}`;
}

export class JiraNeedsReauthError extends JiraApiError {
  constructor(message: string) {
    super({ code: "needs_reauth", message });
  }
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
}

export interface JiraCredentialManagerOptions {
  storage: JiraStorage;
  secrets: SecretStore;
  endpoints: AtlassianEndpoints;
  logger: pino.Logger;
  fetch?: typeof fetch;
  now?: () => number;
}

export class JiraCredentialManager {
  readonly endpoints: AtlassianEndpoints;
  private readonly storage: JiraStorage;
  private readonly secrets: SecretStore;
  private readonly logger: pino.Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly accessTokens = new Map<string, { token: string; expiresAt_ms: number }>();
  private readonly refreshing = new Map<string, Promise<string>>();

  constructor(options: JiraCredentialManagerOptions) {
    this.storage = options.storage;
    this.secrets = options.secrets;
    this.endpoints = options.endpoints;
    this.logger = options.logger.child({ module: "jira-credentials" });
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async saveToken(connectionId: string, token: string): Promise<void> {
    await this.secrets.set(tokenSecretKey(connectionId), token);
  }

  async saveOAuth(
    connectionId: string,
    input: { clientSecret: string; tokens: OAuthTokenSet },
  ): Promise<void> {
    await this.secrets.set(clientSecretKey(connectionId), input.clientSecret);
    if (input.tokens.refreshToken) {
      await this.secrets.set(refreshSecretKey(connectionId), input.tokens.refreshToken);
    }
    this.accessTokens.set(connectionId, {
      token: input.tokens.accessToken,
      expiresAt_ms: input.tokens.expiresAt_ms,
    });
  }

  async forget(connectionId: string): Promise<void> {
    this.accessTokens.delete(connectionId);
    await this.secrets.delete(tokenSecretKey(connectionId));
    await this.secrets.delete(refreshSecretKey(connectionId));
    await this.secrets.delete(clientSecretKey(connectionId));
  }

  baseUrl(connection: StoredJiraConnection): string {
    if (connection.method === "oauth") {
      return `${this.endpoints.apiUrl}/ex/jira/${connection.cloudId ?? ""}`;
    }
    return connection.siteUrl.replace(/\/+$/, "");
  }

  async auth(connection: StoredJiraConnection): Promise<JiraAuth> {
    const baseUrl = this.baseUrl(connection);
    if (connection.method === "oauth") {
      return { baseUrl, authorization: `Bearer ${await this.accessToken(connection)}` };
    }
    const token = await this.secrets.get(tokenSecretKey(connection.id));
    if (token === null) {
      throw new JiraNeedsReauthError("The token for this Jira connection is missing.");
    }
    if (connection.method === "pat") return { baseUrl, authorization: `Bearer ${token}` };
    const basic = Buffer.from(`${connection.email ?? ""}:${token}`).toString("base64");
    return { baseUrl, authorization: `Basic ${basic}` };
  }

  /**
   * Jira rejected `rejected` with 401. For OAuth, refresh unless another request already did,
   * and return the new auth; token methods cannot recover (null).
   */
  async afterUnauthorized(
    connection: StoredJiraConnection,
    rejected: string,
  ): Promise<JiraAuth | null> {
    if (connection.method !== "oauth") return null;
    const cached = this.accessTokens.get(connection.id);
    if (!cached || `Bearer ${cached.token}` === rejected) {
      this.accessTokens.delete(connection.id);
    }
    return this.auth(connection);
  }

  private async accessToken(connection: StoredJiraConnection): Promise<string> {
    const cached = this.accessTokens.get(connection.id);
    if (cached && cached.expiresAt_ms - REFRESH_MARGIN_MS > this.now()) return cached.token;
    return this.refresh(connection);
  }

  private refresh(connection: StoredJiraConnection): Promise<string> {
    const inFlight = this.refreshing.get(connection.id);
    if (inFlight) return inFlight;
    const run = this.runRefresh(connection).finally(() => {
      this.refreshing.delete(connection.id);
    });
    this.refreshing.set(connection.id, run);
    return run;
  }

  private async runRefresh(connection: StoredJiraConnection): Promise<string> {
    const refreshToken = await this.secrets.get(refreshSecretKey(connection.id));
    const clientSecret = await this.secrets.get(clientSecretKey(connection.id));
    if (!refreshToken || !clientSecret || !connection.oauthClientId) {
      await this.markNeedsReauth(connection.id, "Sign in to Jira again.");
      throw new JiraNeedsReauthError("Sign in to Jira again.");
    }
    let tokens: OAuthTokenSet;
    try {
      tokens = await this.requestToken({
        grant_type: "refresh_token",
        client_id: connection.oauthClientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      });
    } catch (error) {
      if (error instanceof JiraNeedsReauthError) {
        await this.markNeedsReauth(connection.id, error.message);
      }
      throw error;
    }
    // Persist the rotated refresh token before anything uses the new access token: if the daemon
    // stops right after this line, the next start still holds the only valid refresh token.
    if (tokens.refreshToken) {
      await this.secrets.set(refreshSecretKey(connection.id), tokens.refreshToken);
    }
    this.accessTokens.set(connection.id, {
      token: tokens.accessToken,
      expiresAt_ms: tokens.expiresAt_ms,
    });
    await this.storage.update(connection.id, {
      authState: "connected",
      tokenExpiresAt_ms: tokens.expiresAt_ms,
      lastError: undefined,
    });
    this.logger.info({ connectionId: connection.id }, "jira oauth token refreshed");
    return tokens.accessToken;
  }

  private async markNeedsReauth(connectionId: string, message: string): Promise<void> {
    this.accessTokens.delete(connectionId);
    await this.storage.update(connectionId, { authState: "needs_reauth", lastError: message });
    this.logger.warn({ connectionId }, "jira connection needs re-authentication");
  }

  /** POST /oauth/token. Throws JiraNeedsReauthError on invalid_grant. */
  async requestToken(body: Record<string, string>): Promise<OAuthTokenSet> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.endpoints.authUrl}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new JiraApiError({
        code: "network",
        message: `Could not reach Atlassian: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    const text = await response.text();
    let parsed: TokenResponse = {};
    try {
      parsed = JSON.parse(text) as TokenResponse;
    } catch {
      parsed = {};
    }
    if (!response.ok || typeof parsed.access_token !== "string") {
      const description =
        typeof parsed.error_description === "string" ? parsed.error_description : null;
      if (parsed.error === "invalid_grant" || response.status === 403) {
        throw new JiraNeedsReauthError(description ?? "Jira sign-in expired. Sign in again.");
      }
      throw new JiraApiError({
        code: response.status === 401 ? "auth_failed" : "jira_error",
        status: response.status,
        message: description ?? `Atlassian token endpoint responded ${response.status}`,
      });
    }
    const expiresIn = typeof parsed.expires_in === "number" ? parsed.expires_in : 3600;
    return {
      accessToken: parsed.access_token,
      refreshToken: typeof parsed.refresh_token === "string" ? parsed.refresh_token : null,
      expiresAt_ms: this.now() + expiresIn * 1000,
    };
  }
}
