import { randomBytes } from "node:crypto";
import {
  JIRA_OAUTH_LOOPBACK_REDIRECT_URI,
  type JiraOAuthSite,
} from "@jagentdesk/protocol/jira/rpc-schemas";
import type { JiraCredentialManager, OAuthTokenSet } from "./credentials.js";
import { JiraApiError } from "./errors.js";
import { arr, objs, str } from "./json.js";

// Jira Cloud OAuth 2.0 (3LO) with an app the user registered (spec 29.1.1, ADR-0034 §2–3).
// Atlassian has no PKCE for 3LO, so the code exchange needs the client secret and runs here.
// The browser part runs on a client: the desktop loopback listener, or the user pastes the URL.

// Classic platform scopes + the granular Jira Software scopes the endpoints we call require
// (reference §4.2). No delete scopes: nothing in JAgentDesk deletes sprints.
export const JIRA_OAUTH_SCOPES = [
  "read:jira-user",
  "read:jira-work",
  "write:jira-work",
  "read:board-scope:jira-software",
  "read:board-scope.admin:jira-software",
  "write:board-scope:jira-software",
  "read:sprint:jira-software",
  "write:sprint:jira-software",
  "read:epic:jira-software",
  "write:epic:jira-software",
  "read:issue:jira-software",
  "write:issue:jira-software",
  "read:project:jira",
  "read:issue-details:jira",
  "read:jql:jira",
  "offline_access",
];

const PENDING_TTL_MS = 15 * 60_000;

export interface PendingOAuth {
  state: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  label: string | null;
  expiresAt_ms: number;
  // After the code exchange, when the user still has to pick a site.
  tokens: OAuthTokenSet | null;
  sites: JiraOAuthSite[] | null;
}

export interface OAuthBegun {
  state: string;
  authorizeUrl: string;
  redirectUri: string;
  expiresAt_ms: number;
}

export interface OAuthGrant {
  pending: PendingOAuth;
  tokens: OAuthTokenSet;
  site: JiraOAuthSite;
}

export type OAuthCompletion =
  | { kind: "grant"; grant: OAuthGrant }
  | { kind: "choose_site"; sites: JiraOAuthSite[] };

/** `code` and `state` from the URL the browser landed on after consent (paste fallback). */
export function parseCallbackUrl(callbackUrl: string): { code: string; state: string } {
  let url: URL;
  try {
    url = new URL(callbackUrl.trim());
  } catch {
    throw new JiraApiError({ code: "invalid_input", message: "That is not a URL." });
  }
  const error = url.searchParams.get("error");
  if (error) {
    const description = url.searchParams.get("error_description") ?? error;
    throw new JiraApiError({
      code: "auth_failed",
      message: `Jira sign-in was refused: ${description}`,
    });
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    throw new JiraApiError({
      code: "invalid_input",
      message: "The URL has no code and state. Copy the address after approving access.",
    });
  }
  return { code, state };
}

export class JiraOAuthFlows {
  private readonly pending = new Map<string, PendingOAuth>();

  constructor(
    private readonly credentials: JiraCredentialManager,
    private readonly fetchImpl: typeof fetch,
    private readonly now: () => number,
  ) {}

  begin(input: {
    clientId: string;
    clientSecret: string;
    redirectUri?: string;
    label?: string;
  }): OAuthBegun {
    this.prune();
    if (!input.clientId.trim() || !input.clientSecret.trim()) {
      throw new JiraApiError({
        code: "invalid_input",
        message: "Client ID and secret are required.",
      });
    }
    const state = randomBytes(24).toString("hex");
    const redirectUri = input.redirectUri?.trim() || JIRA_OAUTH_LOOPBACK_REDIRECT_URI;
    const expiresAt_ms = this.now() + PENDING_TTL_MS;
    this.pending.set(state, {
      state,
      clientId: input.clientId.trim(),
      clientSecret: input.clientSecret.trim(),
      redirectUri,
      label: input.label?.trim() || null,
      expiresAt_ms,
      tokens: null,
      sites: null,
    });
    const url = new URL(`${this.credentials.endpoints.authUrl}/authorize`);
    url.searchParams.set("audience", "api.atlassian.com");
    url.searchParams.set("client_id", input.clientId.trim());
    url.searchParams.set("scope", JIRA_OAUTH_SCOPES.join(" "));
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("prompt", "consent");
    return { state, authorizeUrl: url.toString(), redirectUri, expiresAt_ms };
  }

  async complete(input: {
    state: string;
    code?: string;
    callbackUrl?: string;
    cloudId?: string;
  }): Promise<OAuthCompletion> {
    this.prune();
    let code = input.code ?? null;
    if (input.callbackUrl) {
      const parsed = parseCallbackUrl(input.callbackUrl);
      if (parsed.state !== input.state) {
        throw new JiraApiError({
          code: "invalid_input",
          message: "That URL belongs to a different sign-in attempt. Start again.",
        });
      }
      code = parsed.code;
    }
    const pending = this.pending.get(input.state);
    if (!pending) {
      throw new JiraApiError({
        code: "invalid_input",
        message: "This sign-in expired. Start again.",
      });
    }
    if (!pending.tokens) {
      if (!code) throw new JiraApiError({ code: "invalid_input", message: "Missing code." });
      pending.tokens = await this.credentials.requestToken({
        grant_type: "authorization_code",
        client_id: pending.clientId,
        client_secret: pending.clientSecret,
        code,
        redirect_uri: pending.redirectUri,
      });
      pending.sites = await this.accessibleSites(pending.tokens.accessToken);
    }
    const sites = pending.sites ?? [];
    const onlySite = sites.length === 1 ? sites[0] : undefined;
    const chosen = input.cloudId ? sites.find((site) => site.cloudId === input.cloudId) : onlySite;
    if (!chosen) {
      if (sites.length === 0) {
        this.pending.delete(input.state);
        throw new JiraApiError({
          code: "forbidden",
          message: "This sign-in grants no Jira site. Check the app's Jira API permissions.",
        });
      }
      return { kind: "choose_site", sites };
    }
    this.pending.delete(input.state);
    return { kind: "grant", grant: { pending, tokens: pending.tokens, site: chosen } };
  }

  private async accessibleSites(accessToken: string): Promise<JiraOAuthSite[]> {
    const response = await this.fetchImpl(
      `${this.credentials.endpoints.apiUrl}/oauth/token/accessible-resources`,
      {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      throw new JiraApiError({
        code: "jira_error",
        status: response.status,
        message: `Could not list Jira sites (${response.status}).`,
      });
    }
    const resources = objs(await response.json());
    return resources
      .filter((resource) => arr(resource.scopes).some((scope) => String(scope).includes("jira")))
      .map((resource) => ({
        cloudId: str(resource.id) ?? "",
        name: str(resource.name) ?? "",
        url: str(resource.url) ?? "",
      }));
  }

  private prune(): void {
    const now = this.now();
    for (const [state, pending] of this.pending) {
      if (pending.expiresAt_ms < now) this.pending.delete(state);
    }
  }
}
