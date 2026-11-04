import path from "node:path";
import type pino from "pino";
import type {
  JiraConnection,
  JiraDeployment,
  JiraOAuthDelegation,
  JiraOAuthProgress,
  JiraOAuthSite,
  JiraSwimlaneConfig,
} from "@jagentdesk/protocol/jira/rpc-schemas";
import { FileSecretStore, type SecretStore } from "../database/secret-store.js";
import { ensurePrivateDirectory } from "../private-files.js";
import { JiraCredentialManager, type AtlassianEndpoints } from "./credentials.js";
import { JiraApiError } from "./errors.js";
import { JiraHttp } from "./http.js";
import { str, type Json } from "./json.js";
import { mapUser } from "./mapping.js";
import { JiraOAuthFlows, type OAuthBegun } from "./oauth.js";
import { JiraSite, JiraSiteCache } from "./site.js";
import {
  generateJiraConnectionId,
  JiraStorage,
  toWireConnection,
  type StoredJiraConnection,
} from "./storage.js";
import { JiraWatches } from "./watches.js";
import { CLOUD } from "./flavor.js";

// The daemon's one Jira service (spec 29, ADR-0034 §4): created in bootstrap, shared by every
// client session and the agent tools. It owns connections, the credential manager, OAuth flows in
// progress and the view watches; the per-operation logic lives in board-ops / issue-ops.

export type JiraServiceEvent = JiraOAuthDelegation | JiraOAuthProgress;

export interface JiraServiceOptions {
  jagentdeskHome: string;
  endpoints: AtlassianEndpoints;
  logger: pino.Logger;
  fetch?: typeof fetch;
  now?: () => number;
  pollIntervalMs?: number;
  secrets?: SecretStore;
}

function normalizeSiteUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new JiraApiError({
      code: "invalid_input",
      message: "Enter the site URL, e.g. https://<site>.atlassian.net",
    });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new JiraApiError({
      code: "invalid_input",
      message: "The site URL must start with https://",
    });
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

export class JiraService {
  readonly storage: JiraStorage;
  readonly credentials: JiraCredentialManager;
  readonly watches: JiraWatches;
  private readonly http: JiraHttp;
  private readonly cache = new JiraSiteCache();
  private readonly oauth: JiraOAuthFlows;
  private readonly logger: pino.Logger;
  private readonly now: () => number;
  private readonly listeners = new Set<(event: JiraServiceEvent) => void>();

  constructor(options: JiraServiceOptions) {
    this.logger = options.logger.child({ module: "jira" });
    this.now = options.now ?? Date.now;
    const fetchImpl = options.fetch ?? fetch;
    this.storage = new JiraStorage(options.jagentdeskHome);
    const secretsDir = path.join(options.jagentdeskHome, "jira");
    ensurePrivateDirectory(secretsDir);
    this.credentials = new JiraCredentialManager({
      storage: this.storage,
      secrets: options.secrets ?? new FileSecretStore(secretsDir),
      endpoints: options.endpoints,
      logger: this.logger,
      fetch: fetchImpl,
      now: this.now,
    });
    this.http = new JiraHttp({
      credentials: this.credentials,
      storage: this.storage,
      logger: this.logger,
      fetch: fetchImpl,
    });
    this.oauth = new JiraOAuthFlows(this.credentials, fetchImpl, this.now);
    this.watches = new JiraWatches({
      site: (connectionId) => this.site(connectionId),
      logger: this.logger,
      intervalMs: options.pollIntervalMs,
      now: this.now,
    });
  }

  async initialize(): Promise<void> {
    await this.storage.initialize();
  }

  dispose(): void {
    this.watches.dispose();
  }

  onEvent(listener: (event: JiraServiceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: JiraServiceEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  listConnections(): JiraConnection[] {
    return this.storage.list().map(toWireConnection);
  }

  /** The site of a connection. Throws not_found for an unknown id. */
  site(connectionId: string): JiraSite {
    const connection = this.storage.get(connectionId);
    if (!connection) {
      throw new JiraApiError({ code: "not_found", message: "Unknown Jira connection." });
    }
    return new JiraSite(connection, this.http, this.cache, this.now);
  }

  /** The connection to use when a caller (agent tool) gives none: the only one, else an error. */
  defaultConnectionId(): string {
    const connections = this.storage.list();
    if (connections.length === 1 && connections[0]) return connections[0].id;
    throw new JiraApiError({
      code: "invalid_input",
      message:
        connections.length === 0
          ? "No Jira connection. Add one in JAgentDesk → Jira."
          : "Several Jira connections exist; pass connectionId (see jira_list_connections).",
    });
  }

  async addTokenConnection(input: {
    label?: string;
    deployment: JiraDeployment;
    siteUrl: string;
    method: "api_token" | "pat";
    email?: string;
    token: string;
  }): Promise<JiraConnection> {
    const siteUrl = normalizeSiteUrl(input.siteUrl);
    if (input.deployment === "cloud" && input.method !== "api_token") {
      throw new JiraApiError({
        code: "invalid_input",
        message: "Jira Cloud uses an API token or OAuth.",
      });
    }
    if (input.deployment === "datacenter" && input.method !== "pat") {
      throw new JiraApiError({
        code: "invalid_input",
        message: "Jira Data Center uses a personal access token.",
      });
    }
    if (input.method === "api_token" && !input.email?.trim()) {
      throw new JiraApiError({
        code: "invalid_input",
        message: "Enter the email of your Atlassian account.",
      });
    }
    if (!input.token.trim()) {
      throw new JiraApiError({ code: "invalid_input", message: "Enter the token." });
    }
    const draft: StoredJiraConnection = {
      id: generateJiraConnectionId(),
      label: input.label?.trim() || new URL(siteUrl).host,
      deployment: input.deployment,
      siteUrl,
      method: input.method,
      account: { ref: "", displayName: "" },
      authState: "connected",
      createdAt_ms: this.now(),
      ...(input.method === "api_token" ? { email: input.email?.trim() } : {}),
    };
    await this.credentials.saveToken(draft.id, input.token.trim());
    try {
      const site = new JiraSite(draft, this.http, this.cache, this.now);
      const me: Json = await site.get(site.api("/myself"));
      const account = mapUser(me, site.flavor);
      if (!account)
        throw new JiraApiError({
          code: "auth_failed",
          message: "Jira did not return your account.",
        });
      const stored = await this.storage.add({
        ...draft,
        account,
        ...(str(me.timeZone) ? { timeZone: str(me.timeZone) ?? undefined } : {}),
      });
      this.logger.info(
        { connectionId: stored.id, deployment: stored.deployment },
        "jira connection added",
      );
      return toWireConnection(stored);
    } catch (error) {
      await this.credentials.forget(draft.id);
      throw error;
    }
  }

  async removeConnection(connectionId: string): Promise<void> {
    this.watches.unwatchConnection(connectionId);
    await this.credentials.forget(connectionId);
    this.cache.forget(connectionId);
    await this.storage.remove(connectionId);
    this.logger.info({ connectionId }, "jira connection removed");
  }

  async testConnection(connectionId: string): Promise<JiraConnection> {
    const site = this.site(connectionId);
    const me: Json = await site.get(site.api("/myself"));
    const account = mapUser(me, site.flavor) ?? site.connection.account;
    const updated = await this.storage.update(connectionId, {
      account,
      authState: "connected",
      lastError: undefined,
      ...(str(me.timeZone) ? { timeZone: str(me.timeZone) ?? undefined } : {}),
    });
    if (!updated)
      throw new JiraApiError({ code: "not_found", message: "Unknown Jira connection." });
    return toWireConnection(updated);
  }

  getSwimlanes(connectionId: string, boardId: number): Promise<JiraSwimlaneConfig> {
    return this.storage.getSwimlanes(connectionId, boardId);
  }

  setSwimlanes(
    connectionId: string,
    boardId: number,
    config: JiraSwimlaneConfig,
  ): Promise<JiraSwimlaneConfig> {
    this.site(connectionId);
    return this.storage.setSwimlanes(connectionId, boardId, config);
  }

  beginOAuth(input: {
    clientId: string;
    clientSecret: string;
    redirectUri?: string;
    label?: string;
  }): OAuthBegun {
    return this.oauth.begin(input);
  }

  /** Mobile "Sign in on a desktop": start the flow and ask paired desktops to run the browser part. */
  delegateOAuth(input: {
    clientId: string;
    clientSecret: string;
    redirectUri?: string;
    label?: string;
  }): OAuthBegun {
    const begun = this.oauth.begin(input);
    this.emit({ type: "jira.oauth.delegation", ...begun });
    return begun;
  }

  async completeOAuth(input: {
    state: string;
    code?: string;
    callbackUrl?: string;
    cloudId?: string;
  }): Promise<{ connection: JiraConnection | null; sites: JiraOAuthSite[] | null }> {
    this.emit({ type: "jira.oauth.progress", state: input.state, phase: "exchanging" });
    try {
      const completion = await this.oauth.complete(input);
      if (completion.kind === "choose_site") {
        this.emit({ type: "jira.oauth.progress", state: input.state, phase: "choose_site" });
        return { connection: null, sites: completion.sites };
      }
      const { grant } = completion;
      const draft: StoredJiraConnection = {
        id: generateJiraConnectionId(),
        label: grant.pending.label ?? grant.site.name,
        deployment: "cloud",
        siteUrl: grant.site.url.replace(/\/+$/, ""),
        cloudId: grant.site.cloudId,
        method: "oauth",
        account: { ref: "", displayName: "" },
        authState: "connected",
        tokenExpiresAt_ms: grant.tokens.expiresAt_ms,
        createdAt_ms: this.now(),
        oauthClientId: grant.pending.clientId,
      };
      await this.credentials.saveOAuth(draft.id, {
        clientSecret: grant.pending.clientSecret,
        tokens: grant.tokens,
      });
      try {
        const site = new JiraSite(draft, this.http, this.cache, this.now);
        const me: Json = await site.get(site.api("/myself"));
        const account = mapUser(me, CLOUD);
        if (!account)
          throw new JiraApiError({
            code: "auth_failed",
            message: "Jira did not return your account.",
          });
        const stored = await this.storage.add({
          ...draft,
          account,
          ...(str(me.timeZone) ? { timeZone: str(me.timeZone) ?? undefined } : {}),
        });
        this.logger.info({ connectionId: stored.id }, "jira oauth connection added");
        this.emit({
          type: "jira.oauth.progress",
          state: input.state,
          phase: "done",
          connectionId: stored.id,
        });
        return { connection: toWireConnection(stored), sites: null };
      } catch (error) {
        await this.credentials.forget(draft.id);
        throw error;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({
        type: "jira.oauth.progress",
        state: input.state,
        phase: "failed",
        error: message,
      });
      throw error;
    }
  }
}
