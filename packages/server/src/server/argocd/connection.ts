import type { Logger } from "pino";
import type {
  ArgoCdErrorCode,
  ArgoCdInstance,
  ArgoCdInstanceState,
} from "@jagentdesk/protocol/argocd/rpc-schemas";
import type { SecretStore } from "../database/secret-store.js";
import { ArgoCdError, toArgoCdError } from "./errors.js";
import {
  ArgoCdTlsError,
  argoCdRequest,
  normalizeBaseUrl,
  openArgoCdStream,
  requestAbsolute,
  type ArgoCdHttpRequest,
  type ArgoCdStreamHandle,
  type ArgoCdStreamHandlers,
  type ArgoCdStreamRequest,
  type ArgoCdTransportOptions,
} from "./http.js";
import type { StoredArgoCdInstance } from "./registry.js";

// One logged-in Argo CD instance (spec 30.2.3, ADR-0034 §4). The session token lives here and
// in the FileSecretStore, never on the wire. Refresh is single-flight per instance, and a new
// refresh token is persisted before the new id token is used.

export const MIN_ARGOCD_VERSION: readonly [number, number] = [2, 14];
// Local sessions renew on any request made in their last 5 minutes (reference §1.5); a viewer
// keeps the session alive by calling userinfo this often.
export const KEEPALIVE_INTERVAL_MS = 10 * 60_000;
// SSO id tokens are refreshed this long before they expire.
const SSO_REFRESH_MARGIN_MS = 60_000;

export const secretKeys = {
  token: (id: string) => `argocd.token.${id}`,
  password: (id: string) => `argocd.password.${id}`,
  refresh: (id: string) => `argocd.refresh.${id}`,
  sso: (id: string) => `argocd.sso.${id}`, // token endpoint + client id for refresh
  header: (id: string, name: string) => `argocd.header.${id}.${name}`,
  clientCert: (id: string) => `argocd.mtls_cert.${id}`,
  clientKey: (id: string) => `argocd.mtls_key.${id}`,
};

interface SsoRefreshConfig {
  tokenEndpoint: string;
  clientId: string;
}

export interface SsoTokens extends SsoRefreshConfig {
  idToken: string;
  refreshToken: string | null;
}

export function jwtExpiryMs(token: string): number | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof claims.exp === "number" ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function parseVersion(version: string): [number, number] | null {
  const match = /^v?(\d+)\.(\d+)/.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2])];
}

function isSupportedVersion(version: string): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return true;
  const [major, minor] = parsed;
  return (
    major > MIN_ARGOCD_VERSION[0] ||
    (major === MIN_ARGOCD_VERSION[0] && minor >= MIN_ARGOCD_VERSION[1])
  );
}

interface UserInfo {
  loggedIn: boolean;
  username: string | null;
  groups: string[];
}

function parseUserInfo(body: unknown): UserInfo {
  const info = (body ?? {}) as { loggedIn?: unknown; username?: unknown; groups?: unknown };
  return {
    loggedIn: info.loggedIn === true,
    username: typeof info.username === "string" ? info.username : null,
    groups: Array.isArray(info.groups)
      ? info.groups.filter((group): group is string => typeof group === "string")
      : [],
  };
}

export interface ArgoCdConnectionDeps {
  secrets: SecretStore;
  logger: Logger;
  onChange(): void;
}

export class ArgoCdConnection {
  private token: string | null = null;
  private state: ArgoCdInstanceState = "logged_out";
  private username: string | null;
  private groups: string[] = [];
  private expiresAtMs: number | null = null;
  private serverVersion: string | null = null;
  private lastError: string | null = null;
  private lastErrorCode: ArgoCdErrorCode | null = null;
  private tlsFingerprint: string | null = null;
  private ssoConfigured = false;
  private userLoginsDisabled = false;
  private hasClientCert = false;
  private transportOptions: ArgoCdTransportOptions | null = null;
  private recoverInFlight: Promise<void> | null = null;
  private viewers = 0;
  private keepaliveTimer: NodeJS.Timeout | null = null;

  constructor(
    public record: StoredArgoCdInstance,
    private readonly deps: ArgoCdConnectionDeps,
  ) {
    this.username = record.username;
  }

  get id(): string {
    return this.record.id;
  }

  get currentState(): ArgoCdInstanceState {
    return this.state;
  }

  async load(): Promise<void> {
    this.token = await this.deps.secrets.get(secretKeys.token(this.id));
    this.hasClientCert = (await this.deps.secrets.get(secretKeys.clientKey(this.id))) !== null;
    if (!this.token) {
      this.state = "logged_out";
      return;
    }
    this.expiresAtMs = jwtExpiryMs(this.token);
    const expired = this.expiresAtMs !== null && this.expiresAtMs <= Date.now();
    const canRecover =
      this.record.authMethod === "sso" ||
      (this.record.authMethod === "password" && this.record.rememberPassword);
    this.state = expired && !canRecover ? "needs_reauth" : "connected";
  }

  async updateRecord(record: StoredArgoCdInstance): Promise<void> {
    const authChanged =
      record.url !== this.record.url ||
      record.authMethod !== this.record.authMethod ||
      record.username !== this.record.username;
    this.record = record;
    this.transportOptions = null;
    this.hasClientCert = (await this.deps.secrets.get(secretKeys.clientKey(this.id))) !== null;
    if (authChanged) await this.clearSession("logged_out");
    this.deps.onChange();
  }

  toWire(): ArgoCdInstance {
    return {
      id: this.record.id,
      url: this.record.url,
      displayName: this.record.displayName,
      authMethod: this.record.authMethod,
      username: this.username,
      tlsSkipVerify: this.record.tlsSkipVerify,
      caPem: this.record.caPem,
      headerNames: this.record.headers,
      hasClientCert: this.hasClientCert,
      rememberPassword: this.record.rememberPassword,
      createdAt_ms: this.record.createdAt_ms,
      state: this.state,
      groups: this.groups,
      expiresAt_ms: this.expiresAtMs,
      serverVersion: this.serverVersion,
      lastError: this.lastError,
      lastErrorCode: this.lastErrorCode,
      tlsFingerprintSha256: this.tlsFingerprint,
      ssoConfigured: this.ssoConfigured,
      userLoginsDisabled: this.userLoginsDisabled,
    };
  }

  async transport(): Promise<ArgoCdTransportOptions> {
    if (this.transportOptions) return this.transportOptions;
    const headers: Record<string, string> = {};
    for (const name of this.record.headers) {
      const value = await this.deps.secrets.get(secretKeys.header(this.id, name));
      if (value !== null) headers[name] = value;
    }
    this.transportOptions = {
      baseUrl: normalizeBaseUrl(this.record.url),
      tlsSkipVerify: this.record.tlsSkipVerify,
      caPem: this.record.caPem,
      clientCertPem: await this.deps.secrets.get(secretKeys.clientCert(this.id)),
      clientKeyPem: await this.deps.secrets.get(secretKeys.clientKey(this.id)),
      headers,
    };
    return this.transportOptions;
  }

  /** Unauthenticated probe: server version, SSO config, local-login flag (reference §1.1). */
  async probe(): Promise<void> {
    const transport = await this.transport();
    try {
      const version = await argoCdRequest(transport, {
        method: "GET",
        path: "/api/version",
        token: this.token,
      });
      const versionText = (version.body as { Version?: unknown }).Version;
      this.serverVersion = typeof versionText === "string" ? versionText : null;
      const settings = await argoCdRequest(transport, {
        method: "GET",
        path: "/api/v1/settings",
        token: null,
      });
      const body = settings.body as {
        oidcConfig?: { issuer?: unknown };
        dexConfig?: { connectors?: unknown };
        userLoginsDisabled?: unknown;
      };
      const connectors = body.dexConfig?.connectors;
      this.ssoConfigured =
        typeof body.oidcConfig?.issuer === "string" ||
        (Array.isArray(connectors) && connectors.length > 0);
      this.userLoginsDisabled = body.userLoginsDisabled === true;
      this.tlsFingerprint = null;
    } catch (error) {
      if (error instanceof ArgoCdTlsError) this.tlsFingerprint = error.fingerprintSha256;
      throw error;
    }
    if (this.serverVersion && !isSupportedVersion(this.serverVersion)) {
      throw new ArgoCdError(
        "unsupported_version",
        `Argo CD ${this.serverVersion} is not supported. JAgentDesk needs 2.14 or newer.`,
      );
    }
  }

  async loginWithPassword(password: string | undefined): Promise<void> {
    await this.runLogin(async () => {
      const username = this.record.username;
      if (!username) throw new ArgoCdError("invalid_input", "Username is required.");
      const supplied = password ?? (await this.deps.secrets.get(secretKeys.password(this.id)));
      if (!supplied) throw new ArgoCdError("needs_reauth", "Password is required.");
      await this.probe();
      const transport = await this.transport();
      const response = await argoCdRequest(transport, {
        method: "POST",
        path: "/api/v1/session",
        body: { username, password: supplied },
        token: null,
      });
      const token = (response.body as { token?: unknown }).token;
      if (typeof token !== "string")
        throw new ArgoCdError("argocd_error", "Argo CD returned no token.");
      if (this.record.rememberPassword) {
        await this.deps.secrets.set(secretKeys.password(this.id), supplied);
      } else {
        await this.deps.secrets.delete(secretKeys.password(this.id));
      }
      await this.adoptToken(token);
      await this.refreshUserInfo();
    });
  }

  async loginWithToken(token: string): Promise<void> {
    await this.runLogin(async () => {
      await this.probe();
      const info = parseUserInfo(
        (
          await argoCdRequest(await this.transport(), {
            method: "GET",
            path: "/api/v1/session/userinfo",
            token,
          })
        ).body,
      );
      if (!info.loggedIn) throw new ArgoCdError("unauthenticated", "Argo CD rejected the token.");
      await this.adoptToken(token);
      this.applyUserInfo(info);
    });
  }

  async adoptSso(tokens: SsoTokens): Promise<void> {
    await this.runLogin(async () => {
      if (tokens.refreshToken) {
        await this.deps.secrets.set(secretKeys.refresh(this.id), tokens.refreshToken);
      }
      await this.deps.secrets.set(
        secretKeys.sso(this.id),
        JSON.stringify({ tokenEndpoint: tokens.tokenEndpoint, clientId: tokens.clientId }),
      );
      await this.adoptToken(tokens.idToken);
      await this.refreshUserInfo();
    });
  }

  async logout(): Promise<void> {
    if (this.token && this.record.authMethod !== "token") {
      try {
        await argoCdRequest(await this.transport(), {
          method: "DELETE",
          path: "/api/v1/session",
          token: this.token,
        });
      } catch (error) {
        this.deps.logger.warn({ err: error, instanceId: this.id }, "Argo CD logout failed");
      }
    }
    await this.deps.secrets.delete(secretKeys.password(this.id));
    await this.clearSession("logged_out");
    this.deps.onChange();
  }

  /** Removes every secret of this instance (delete instance). */
  async forget(): Promise<void> {
    this.stopKeepalive();
    await this.deps.secrets.delete(secretKeys.token(this.id));
    await this.deps.secrets.delete(secretKeys.password(this.id));
    await this.deps.secrets.delete(secretKeys.refresh(this.id));
    await this.deps.secrets.delete(secretKeys.sso(this.id));
    await this.deps.secrets.delete(secretKeys.clientCert(this.id));
    await this.deps.secrets.delete(secretKeys.clientKey(this.id));
    for (const name of this.record.headers) {
      await this.deps.secrets.delete(secretKeys.header(this.id, name));
    }
  }

  async request(request: Omit<ArgoCdHttpRequest, "token">): Promise<unknown> {
    const transport = await this.transport();
    const token = await this.validToken();
    try {
      const response = await argoCdRequest(transport, { ...request, token });
      if (response.renewedToken && response.renewedToken !== token) {
        await this.adoptToken(response.renewedToken);
      }
      return response.body;
    } catch (error) {
      const failure = toArgoCdError(error);
      if (failure.code !== "unauthenticated") throw failure;
      await this.recover(failure.message);
      const retried = await argoCdRequest(transport, {
        ...request,
        token: await this.validToken(),
      });
      return retried.body;
    }
  }

  async stream(
    request: Omit<ArgoCdStreamRequest, "token">,
    handlers: ArgoCdStreamHandlers,
  ): Promise<ArgoCdStreamHandle> {
    const transport = await this.transport();
    const token = await this.validToken();
    return openArgoCdStream(transport, { ...request, token }, handlers);
  }

  /** A stream closed with 401: recover the session the same way a request would. */
  async recoverFromStreamAuthFailure(message: string): Promise<void> {
    await this.recover(message);
  }

  startViewing(): void {
    this.viewers += 1;
    if (this.keepaliveTimer || this.state !== "connected") return;
    this.keepaliveTimer = setInterval(() => {
      void this.refreshUserInfo().catch((error: unknown) => {
        this.deps.logger.warn({ err: error, instanceId: this.id }, "Argo CD keepalive failed");
      });
    }, KEEPALIVE_INTERVAL_MS);
    this.keepaliveTimer.unref();
  }

  stopViewing(): void {
    this.viewers = Math.max(0, this.viewers - 1);
    if (this.viewers === 0) this.stopKeepalive();
  }

  dispose(): void {
    this.stopKeepalive();
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  private async runLogin(login: () => Promise<void>): Promise<void> {
    this.state = "connecting";
    this.lastError = null;
    this.lastErrorCode = null;
    this.deps.onChange();
    try {
      await login();
      this.state = "connected";
      if (this.viewers > 0) {
        this.viewers -= 1;
        this.startViewing();
      }
    } catch (error) {
      const failure = toArgoCdError(error);
      this.state = "error";
      this.lastError = failure.message;
      this.lastErrorCode = failure.code;
      throw failure;
    } finally {
      this.deps.onChange();
    }
  }

  private async refreshUserInfo(): Promise<void> {
    const body = await this.request({ method: "GET", path: "/api/v1/session/userinfo" });
    const info = parseUserInfo(body);
    if (!info.loggedIn) {
      await this.recover("Argo CD session is no longer valid.");
      return;
    }
    this.applyUserInfo(info);
  }

  private applyUserInfo(info: UserInfo): void {
    if (info.username) this.username = info.username;
    this.groups = info.groups;
  }

  private async adoptToken(token: string): Promise<void> {
    await this.deps.secrets.set(secretKeys.token(this.id), token);
    this.token = token;
    this.expiresAtMs = jwtExpiryMs(token);
    if (this.state !== "connecting") this.deps.onChange();
  }

  private async validToken(): Promise<string> {
    if (!this.token) {
      throw new ArgoCdError(
        this.state === "needs_reauth" ? "needs_reauth" : "unauthenticated",
        "Sign in to this Argo CD instance first.",
      );
    }
    const nearExpiry =
      this.expiresAtMs !== null && this.expiresAtMs - SSO_REFRESH_MARGIN_MS <= Date.now();
    if (nearExpiry) await this.recover("The Argo CD session expired.");
    if (!this.token)
      throw new ArgoCdError("needs_reauth", "Sign in to this Argo CD instance again.");
    return this.token;
  }

  // Single flight: concurrent 401s share one re-login / refresh.
  private recover(reason: string): Promise<void> {
    if (!this.recoverInFlight) {
      this.recoverInFlight = this.recoverNow(reason).finally(() => {
        this.recoverInFlight = null;
      });
    }
    return this.recoverInFlight;
  }

  private async recoverNow(reason: string): Promise<void> {
    if (this.record.authMethod === "sso") {
      const refreshed = await this.refreshSso();
      if (refreshed) return;
    }
    if (this.record.authMethod === "password" && this.record.rememberPassword) {
      const password = await this.deps.secrets.get(secretKeys.password(this.id));
      if (password) {
        await this.loginWithPassword(password);
        return;
      }
    }
    await this.clearSession("needs_reauth");
    this.lastError = reason;
    this.lastErrorCode = "needs_reauth";
    this.deps.onChange();
    throw new ArgoCdError("needs_reauth", `${reason} Sign in again.`);
  }

  private async refreshSso(): Promise<boolean> {
    const refreshToken = await this.deps.secrets.get(secretKeys.refresh(this.id));
    const configRaw = await this.deps.secrets.get(secretKeys.sso(this.id));
    if (!refreshToken || !configRaw) return false;
    const config = JSON.parse(configRaw) as SsoRefreshConfig;
    const response = await requestAbsolute(await this.transport(), {
      method: "POST",
      url: config.tokenEndpoint,
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: config.clientId,
      }).toString(),
    });
    if (response.status < 200 || response.status >= 300) {
      this.deps.logger.warn(
        { instanceId: this.id, status: response.status },
        "Argo CD SSO refresh rejected",
      );
      return false;
    }
    const body = JSON.parse(response.text) as { id_token?: unknown; refresh_token?: unknown };
    if (typeof body.id_token !== "string") return false;
    // ADR-0034 §4: the new refresh token is stored before the new id token is used.
    if (typeof body.refresh_token === "string") {
      await this.deps.secrets.set(secretKeys.refresh(this.id), body.refresh_token);
    }
    await this.adoptToken(body.id_token);
    return true;
  }

  private async clearSession(state: ArgoCdInstanceState): Promise<void> {
    this.stopKeepalive();
    this.token = null;
    this.expiresAtMs = null;
    this.groups = [];
    this.state = state;
    await this.deps.secrets.delete(secretKeys.token(this.id));
    await this.deps.secrets.delete(secretKeys.refresh(this.id));
    await this.deps.secrets.delete(secretKeys.sso(this.id));
  }
}
