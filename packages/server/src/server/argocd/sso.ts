import { createHash, randomBytes } from "node:crypto";
import { ArgoCdError } from "./errors.js";
import { argoCdRequest, requestAbsolute, type ArgoCdTransportOptions } from "./http.js";
import type { SsoTokens } from "./connection.js";

// SSO like `argocd login --sso` (spec 30.2.1, reference §2.3): PKCE S256 with the CLI's
// redirect URI. The daemon owns `state` and `code_verifier`; the desktop only relays `code`.

export const SSO_CALLBACK_PORT = 8085;
export const SSO_REDIRECT_URI = `http://localhost:${SSO_CALLBACK_PORT}/auth/callback`;
export const SSO_TIMEOUT_MS = 5 * 60_000;
// Argo CD's bundled Dex registers this public client with the localhost redirect (DEX-CFG).
const DEX_CLI_CLIENT_ID = "argo-cd-cli";
const DEFAULT_SCOPES = ["openid", "profile", "email", "groups"];

interface OidcSettings {
  issuer: string;
  clientId: string;
  scopes: string[];
}

interface PendingSso {
  instanceId: string;
  verifier: string;
  tokenEndpoint: string;
  clientId: string;
  expiresAtMs: number;
}

export interface SsoBegin {
  authUrl: string;
  state: string;
  redirectUri: string;
  expiresAtMs: number;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

// APICLIENT OIDCConfig(): a direct OIDC issuer wins; otherwise the bundled Dex.
function resolveOidcSettings(settings: unknown): OidcSettings {
  const body = (settings ?? {}) as {
    url?: unknown;
    oidcConfig?: { issuer?: unknown; clientID?: unknown; cliClientID?: unknown; scopes?: unknown };
    dexConfig?: { connectors?: unknown };
  };
  const oidc = body.oidcConfig;
  if (oidc && typeof oidc.issuer === "string" && oidc.issuer) {
    const cliClientId = typeof oidc.cliClientID === "string" ? oidc.cliClientID : "";
    const clientId = cliClientId || (typeof oidc.clientID === "string" ? oidc.clientID : "");
    const scopes = stringArray(oidc.scopes);
    return { issuer: oidc.issuer, clientId, scopes: scopes.length > 0 ? scopes : DEFAULT_SCOPES };
  }
  const connectors = body.dexConfig?.connectors;
  if (Array.isArray(connectors) && connectors.length > 0) {
    const url = typeof body.url === "string" ? body.url.replace(/\/+$/, "") : "";
    if (!url) {
      throw new ArgoCdError(
        "sso_unavailable",
        "Argo CD has Dex connectors but no `url` in argocd-cm, so its SSO issuer is unknown.",
      );
    }
    return {
      issuer: `${url}/api/dex`,
      clientId: DEX_CLI_CLIENT_ID,
      scopes: [...DEFAULT_SCOPES, "federated:id"],
    };
  }
  throw new ArgoCdError("sso_unavailable", "SSO is not configured on this Argo CD instance.");
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function discover(
  transport: ArgoCdTransportOptions,
  issuer: string,
): Promise<{ authorizationEndpoint: string; tokenEndpoint: string; scopesSupported: string[] }> {
  const response = await requestAbsolute(transport, {
    method: "GET",
    url: `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`,
    headers: { Accept: "application/json" },
    body: null,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new ArgoCdError(
      "sso_unavailable",
      `OIDC discovery failed at ${issuer} (HTTP ${response.status}).`,
    );
  }
  const body = JSON.parse(response.text) as {
    authorization_endpoint?: unknown;
    token_endpoint?: unknown;
    scopes_supported?: unknown;
  };
  if (typeof body.authorization_endpoint !== "string" || typeof body.token_endpoint !== "string") {
    throw new ArgoCdError("sso_unavailable", `OIDC discovery at ${issuer} has no endpoints.`);
  }
  return {
    authorizationEndpoint: body.authorization_endpoint,
    tokenEndpoint: body.token_endpoint,
    scopesSupported: stringArray(body.scopes_supported),
  };
}

export class ArgoCdSsoFlows {
  private readonly pending = new Map<string, PendingSso>();

  async begin(instanceId: string, transport: ArgoCdTransportOptions): Promise<SsoBegin> {
    this.prune();
    const settings = await argoCdRequest(transport, {
      method: "GET",
      path: "/api/v1/settings",
      token: null,
    });
    const oidc = resolveOidcSettings(settings.body);
    const endpoints = await discover(transport, oidc.issuer);
    const scopes = [...oidc.scopes];
    if (
      endpoints.scopesSupported.includes("offline_access") &&
      !scopes.includes("offline_access")
    ) {
      scopes.push("offline_access");
    }
    const { verifier, challenge } = pkcePair();
    const state = randomBytes(16).toString("base64url");
    const expiresAtMs = Date.now() + SSO_TIMEOUT_MS;
    for (const [key, entry] of this.pending) {
      if (entry.instanceId === instanceId) this.pending.delete(key);
    }
    this.pending.set(state, {
      instanceId,
      verifier,
      tokenEndpoint: endpoints.tokenEndpoint,
      clientId: oidc.clientId,
      expiresAtMs,
    });
    const authUrl = new URL(endpoints.authorizationEndpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", oidc.clientId);
    authUrl.searchParams.set("redirect_uri", SSO_REDIRECT_URI);
    authUrl.searchParams.set("scope", scopes.join(" "));
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("access_type", "offline");
    return { authUrl: authUrl.toString(), state, redirectUri: SSO_REDIRECT_URI, expiresAtMs };
  }

  /** Drops the pending flow (error relayed from the desktop). */
  cancel(state: string): void {
    this.pending.delete(state);
  }

  async complete(input: {
    instanceId: string;
    state: string;
    code: string;
    transport: ArgoCdTransportOptions;
  }): Promise<SsoTokens> {
    this.prune();
    const pending = this.pending.get(input.state);
    if (!pending || pending.instanceId !== input.instanceId) {
      throw new ArgoCdError(
        "sso_state_mismatch",
        "This sign-in is unknown or expired. Start SSO again.",
      );
    }
    this.pending.delete(input.state);
    const response = await requestAbsolute(input.transport, {
      method: "POST",
      url: pending.tokenEndpoint,
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: SSO_REDIRECT_URI,
        client_id: pending.clientId,
        code_verifier: pending.verifier,
      }).toString(),
    });
    const body = JSON.parse(response.text || "{}") as {
      id_token?: unknown;
      refresh_token?: unknown;
      error?: unknown;
      error_description?: unknown;
    };
    if (response.status < 200 || response.status >= 300 || typeof body.id_token !== "string") {
      const idpMessage = [body.error, body.error_description]
        .filter((part): part is string => typeof part === "string")
        .join(": ");
      throw new ArgoCdError(
        "sso_idp_error",
        `${idpMessage || `Token exchange failed (HTTP ${response.status})`}. You can sign in with an API token instead.`,
      );
    }
    return {
      idToken: body.id_token,
      refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
      tokenEndpoint: pending.tokenEndpoint,
      clientId: pending.clientId,
    };
  }

  private prune(): void {
    const now = Date.now();
    for (const [state, entry] of this.pending) {
      if (entry.expiresAtMs <= now) this.pending.delete(state);
    }
  }
}
