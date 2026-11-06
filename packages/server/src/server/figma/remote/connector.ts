import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import type { Logger } from "pino";
import { z } from "zod";
import type {
  FigmaRemoteCallResult,
  FigmaRemoteStatus,
} from "@jagentdesk/protocol/figma/rpc-schemas";
import { CodexAppServerRpcError } from "../../agent/providers/codex/app-server-transport.js";
import { CodexAppServerClient } from "../../agent/providers/codex/app-server-transport.js";
import {
  checkProviderLaunchAvailable,
  resolveProviderLaunch,
} from "../../agent/provider-launch-config.js";
import { findDefaultCodexBinary } from "../../agent/providers/codex-app-server-agent.js";
import { spawnProcess } from "../../../utils/spawn.js";
import { ensurePrivateDirectory, writePrivateFileAtomicSync } from "../../private-files.js";
import { figmaIdentityLabel } from "./identity.js";
import type {
  FigmaRemoteExecuteInput,
  FigmaRemoteExecuteOutcome,
  FigmaRemoteGateway,
} from "../context.js";

// The provider-independent Figma write connector (spec 32.7 / ADR-0040). One dedicated
// `codex app-server` child per daemon, started lazily on the first explicit connect. It is
// driven only through the native MCP methods `mcpServerStatus/list` and `mcpServer/tool/call`
// — no turn/start, no Codex model, no provider/model switch for the chat. The child runs with
// a private CODEX_HOME ($JAGENTDESK_HOME/figma/remote-codex, credentials store file) and no
// inherited OpenAI auth vars, so it never shares or disturbs the user's global Codex
// credentials/keyring. The Figma token lives in that store, owned by Codex — the daemon never
// reads, copies, or parses it.

export const FIGMA_REMOTE_SERVER_NAME = "figma";
export const FIGMA_REMOTE_ENDPOINT = "https://mcp.figma.com/mcp";
/** `use_figma` code ceiling (ADR-0040): 64 KiB UTF-8. */
export const FIGMA_REMOTE_MAX_CODE_BYTES = 64 * 1024;
export const FIGMA_REMOTE_DESCRIPTION_MIN = 1;
export const FIGMA_REMOTE_DESCRIPTION_MAX = 1000;

/** The slice of `CodexAppServerClient` the connector drives; injectable for focused tests. */
export interface NativeMcpRpcClient {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  setRequestHandler(method: string, handler: (params: unknown) => unknown): void;
  setNotificationHandler(handler: (method: string, params: unknown) => void): void;
  setUnexpectedTerminationHandler(handler: (error: Error) => void): void;
  dispose(): Promise<void>;
}

export type NativeMcpClientFactory = () => Promise<NativeMcpRpcClient>;

export interface FigmaRemoteConnectorDeps {
  jagentdeskHome: string;
  logger: pino.Logger;
  /** Injectable transport (defaults to spawning the real `codex app-server`). */
  createClient?: NativeMcpClientFactory;
  timeouts?: Partial<FigmaRemoteTimeouts>;
}

export interface FigmaRemoteTimeouts {
  initialize: number;
  threadStart: number;
  serverStatus: number;
  oauthLogin: number;
  toolCall: number;
}

const DEFAULT_TIMEOUTS: FigmaRemoteTimeouts = {
  initialize: 20_000,
  threadStart: 40_000,
  serverStatus: 40_000,
  oauthLogin: 30_000,
  toolCall: 120_000,
};

const RemoteConfigSchema = z.object({ enabled: z.boolean().default(false) });

/** JSON-RPC "Method not found" — the transport is experimental; report, never guess. */
function isUnknownMethodError(error: unknown): boolean {
  return error instanceof CodexAppServerRpcError && error.code === -32601;
}

/** The transport's own timeout rejection shape (app-server-transport.ts). */
function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("timed out");
}

/**
 * A dispatched `mcpServer/tool/call` whose outcome the connector cannot vouch for: a timeout,
 * a helper restart/disconnect mid-call, or a declined native approval. The write may or may
 * not have landed, so callers MUST drop the stale version memo even though the call failed.
 * Errors thrown before dispatch (guards, inventory, request limits) are plain Errors.
 */
export class FigmaRemoteOutcomeUnknownError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "FigmaRemoteOutcomeUnknownError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only an official Figma HTTPS URL may be handed to the app's browser-open button (32.2 rule).
 * Exact auth hosts only — no arbitrary subdomains, no userinfo, and 443 is the only port. */
const FIGMA_AUTH_HOSTS = new Set(["figma.com", "www.figma.com", "api.figma.com"]);

export function validateFigmaAuthorizationUrl(url: unknown): string | undefined {
  if (typeof url !== "string" || !url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") return undefined;
  if (parsed.username || parsed.password) return undefined;
  if (parsed.port && parsed.port !== "443") return undefined;
  if (!FIGMA_AUTH_HOSTS.has(parsed.hostname.toLowerCase())) return undefined;
  return url;
}

/**
 * Does the ACTUAL inventory advertise these top-level tool parameters? The connector never
 * invents a schema: a `use_figma` whose real inputSchema lacks `fileKey`/`code` fails closed.
 */
function toolAdvertisesParameters(
  tool: unknown,
  parameters: readonly string[],
): tool is { inputSchema?: unknown } {
  if (!isRecord(tool)) return false;
  const schema = tool.inputSchema;
  const props = isRecord(schema) ? schema.properties : undefined;
  if (!isRecord(props)) return false;
  return parameters.every((name) => Object.hasOwn(props, name));
}

/** One dedicated app-server per daemon; every async step is generation-guarded. */
export class FigmaRemoteConnector implements FigmaRemoteGateway {
  private readonly deps: Required<Pick<FigmaRemoteConnectorDeps, "jagentdeskHome" | "logger">> & {
    createClient: NativeMcpClientFactory;
    timeouts: FigmaRemoteTimeouts;
  };
  private readonly configFile: string;
  private readonly codexHomeDir: string;
  private readonly workDir: string;

  private enabled: boolean | null = null;
  private client: NativeMcpRpcClient | null = null;
  private threadId: string | null = null;
  private starting: Promise<void> | null = null;
  private generation = 0;
  /**
   * Bumped whenever the owned process is released (disconnect, dispose, unexpected exit) —
   * never by a start. A pending `authBegin` pins the epoch it launched on: after any release
   * it reports state only, never driving OAuth on another operation's brand-new client and
   * never returning a stale authorization URL.
   */
  private lifecycleEpoch = 0;
  /** One best-effort identity attempt per lifecycle generation (polls must not backlog writes). */
  private identityAttemptedGeneration = -1;
  private state: FigmaRemoteStatus["state"] = "disconnected";
  private stateMessage: string | undefined;
  private identityText: string | undefined;
  private tools: Record<string, unknown> = {};
  /** Count of native elicitations observed; exposed for focused tests and diagnostics. */
  elicitationCount = 0;
  /** The one call currently holding the tool-call mutex; elicitations mark its token. */
  private activeCall: { tool: string; elicited: boolean } | null = null;
  /** Single-flight `mcpServer/oauth/login` so duplicate Connect/Continue cannot stack flows. */
  private authInFlight: Promise<{ status: FigmaRemoteStatus; authorizationUrl?: string }> | null =
    null;
  /** Single-flight native status refresh (bounded by the serverStatus timeout). */
  private statusRefresh: Promise<void> | null = null;
  private statusRefreshGeneration = -1;
  /** Serialization tail for `mcpServer/tool/call`: one dispatched call at a time. */
  private toolQueue: Promise<void> = Promise.resolve();

  constructor(deps: FigmaRemoteConnectorDeps) {
    const figmaDir = path.join(deps.jagentdeskHome, "figma");
    this.configFile = path.join(figmaDir, "remote.json");
    this.codexHomeDir = path.join(figmaDir, "remote-codex");
    this.workDir = path.join(figmaDir, "remote-work");
    this.deps = {
      jagentdeskHome: deps.jagentdeskHome,
      logger: deps.logger.child({ module: "figma-remote" }),
      createClient:
        deps.createClient ?? (() => spawnCodexAppServer(this.codexHomeDir, this.workDir)),
      timeouts: { ...DEFAULT_TIMEOUTS, ...deps.timeouts },
    };
  }

  // ── persisted enabled flag (private figma/remote.json, default off) ─────────────
  // The boolean is the only thing stored; no tokens, so a corrupt file is not a
  // migration problem — an unreadable config simply means "off".

  private async loadEnabled(): Promise<boolean> {
    if (this.enabled !== null) return this.enabled;
    try {
      const parsed = RemoteConfigSchema.safeParse(
        JSON.parse(await readFile(this.configFile, "utf8")),
      );
      this.enabled = parsed.success ? parsed.data.enabled : false;
    } catch {
      this.enabled = false;
    }
    return this.enabled;
  }

  private async saveEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    try {
      writePrivateFileAtomicSync(this.configFile, JSON.stringify({ enabled }, null, 2));
    } catch (error) {
      this.deps.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "figma remote.json write failed",
      );
    }
  }

  // ── status ──────────────────────────────────────────────────────────────────────

  /**
   * While a process is owned, a status read re-checks the ACTUAL native status (bounded,
   * single-flight) so a pending startup notification must settle into an observable terminal
   * state instead of freezing at "connecting". No OAuth call, no spawn: an unstarted
   * connector is pure snapshot. Reflects observed native events only.
   */
  async getStatus(): Promise<FigmaRemoteStatus> {
    const enabled = await this.loadEnabled();
    // When the connector is off, the persisted flag wins: error/unavailable only
    // describe a process the daemon actually owned.
    if (!enabled) return { state: "disconnected" };
    if (this.client && this.threadId) await this.refreshServerStatus(this.generation);
    return this.snapshot();
  }

  private snapshot(): FigmaRemoteStatus {
    return {
      state: this.state,
      ...(this.stateMessage ? { message: this.stateMessage } : {}),
      ...(this.identityText ? { identityText: this.identityText } : {}),
    };
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────────

  /** Lazy, single-flight start of the dedicated app-server and its one ephemeral thread. */
  private ensureStarted(): Promise<void> {
    if (this.client) return Promise.resolve();
    if (!this.starting) {
      const starting = this.startOnce().finally(() => {
        // Never clobber a newer start's promise (disconnect + reconnect while we were pending).
        if (this.starting === starting) this.starting = null;
      });
      this.starting = starting;
    }
    return this.starting;
  }

  /** True when this async step still owns the connector's lifecycle state. */
  private owns(generation: number): boolean {
    return generation === this.generation;
  }

  /**
   * Every await boundary checks ownership: a disconnect that lands while the factory,
   * initialize, or thread/start is in flight abandons this start — the late child is disposed
   * and no stale step may overwrite state, the client pointer, or a newer startPromise.
   */
  private async startOnce(): Promise<void> {
    const generation = ++this.generation;
    this.state = "connecting";
    this.stateMessage = undefined;
    let client: NativeMcpRpcClient;
    try {
      client = await this.deps.createClient();
    } catch (error) {
      if (!this.owns(generation)) return; // abandoned: disconnect already reset the state
      const message = error instanceof Error ? error.message : String(error);
      this.state = "unavailable";
      this.stateMessage = message;
      return;
    }
    if (!this.owns(generation)) {
      await client.dispose().catch(() => {});
      return;
    }
    client.setNotificationHandler((method, params) =>
      this.onNotification(generation, method, params),
    );
    // An elicitation the connector cannot answer semantically must fail the call clear —
    // never blanket-accept an approval request that was not ours to grant. Log only the
    // method/outcome: raw params can carry the auth URL or user input.
    client.setRequestHandler("mcpServer/elicitation/request", (_params) => {
      this.elicitationCount++;
      if (this.activeCall) {
        this.activeCall.elicited = true;
      }
      this.deps.logger.debug(
        { method: "mcpServer/elicitation/request", action: "decline", tool: this.activeCall?.tool },
        "figma remote elicitation declined",
      );
      return { action: "decline", content: null };
    });
    client.setUnexpectedTerminationHandler(() => {
      if (generation !== this.generation) return;
      // No automatic retry: a dropped child leaves the last execute's outcome unknown.
      // Bumping the generation abandons any in-flight refresh of this owned process too.
      this.generation++;
      this.lifecycleEpoch++;
      this.client = null;
      this.threadId = null;
      this.tools = {};
      this.starting = null;
      this.authInFlight = null;
      this.state = this.enabled ? "error" : "disconnected";
      this.stateMessage =
        "The Figma editing helper stopped unexpectedly. Try Connect editing again.";
    });
    try {
      await client.request(
        "initialize",
        {
          clientInfo: {
            name: "jagentdesk_figma_write_connector",
            title: "JAgentDesk Figma editing connector",
            version: "1",
          },
          capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true },
        },
        this.deps.timeouts.initialize,
      );
      // Gate BEFORE the first post-initialize side effect: an abandoned start must not even
      // notify the child it is proceeding, and never dispatches thread/start.
      if (!this.owns(generation)) {
        await client.dispose().catch(() => {});
        return;
      }
      client.notify("initialized");
      const started = await client.request(
        "thread/start",
        {
          cwd: this.workDir,
          ephemeral: true,
          sandbox: "read-only",
          approvalPolicy: "never",
          config: {
            mcp_servers: {
              [FIGMA_REMOTE_SERVER_NAME]: {
                url: FIGMA_REMOTE_ENDPOINT,
                // Safe only because every execute goes through the JAD permission card first.
                default_tools_approval_mode: "auto",
              },
            },
          },
        },
        this.deps.timeouts.threadStart,
      );
      if (!this.owns(generation)) {
        await client.dispose().catch(() => {});
        return;
      }
      const threadId =
        isRecord(started) && isRecord(started.thread) ? started.thread.id : undefined;
      if (typeof threadId !== "string" || !threadId) {
        throw new Error("Codex did not create the editing thread");
      }
      this.client = client;
      this.threadId = threadId;
    } catch (error) {
      await client.dispose().catch(() => {});
      if (!this.owns(generation)) return; // abandoned: never overwrite newer state
      if (isUnknownMethodError(error)) {
        this.state = "unavailable";
        this.stateMessage =
          "This Codex version does not support native MCP tool calls. Update Codex (requires 0.165+).";
      } else {
        this.state = "error";
        this.stateMessage = error instanceof Error ? error.message : String(error);
      }
      return;
    }
    await this.refreshServerStatus(generation);
  }

  private async stopOwned(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.threadId = null;
    this.tools = {};
    this.generation++;
    // Abandon the lifecycle: a pending authBegin must not drive OAuth on a future client,
    // and a deliberate new Connect must not wait behind the old OAuth request. The stale
    // attempt's finally compares identity, so clearing here never clobbers newer work.
    this.lifecycleEpoch++;
    this.authInFlight = null;
    this.identityAttemptedGeneration = -1;
    this.state = "disconnected";
    this.stateMessage = undefined;
    this.identityText = undefined;
    // A reconnect after a disconnect must start fresh, not piggyback the abandoned attempt.
    this.starting = null;
    if (client) await client.dispose().catch(() => {});
  }

  /**
   * Explicit native OAuth. Returns the validated Figma HTTPS URL for the app's browser button.
   * Single-flight: duplicate Connect/Continue taps share one `mcpServer/oauth/login` rather
   * than stacking native OAuth flows.
   */
  async authBegin(): Promise<{ status: FigmaRemoteStatus; authorizationUrl?: string }> {
    if (this.authInFlight) return this.authInFlight;
    const begun = this.authBeginOnce().finally(() => {
      if (this.authInFlight === begun) this.authInFlight = null;
    });
    this.authInFlight = begun;
    return begun;
  }

  private async authBeginOnce(): Promise<{
    status: FigmaRemoteStatus;
    authorizationUrl?: string;
  }> {
    await this.saveEnabled(true);
    // Pin the lifecycle this attempt launched on. A start's own generation bump is not a
    // release; only disconnect/dispose/termination increments the epoch. Once released, this
    // attempt reports state only — it never drives OAuth on a reconnect's new client and
    // never hands back a stale authorization URL.
    const attempt = this.lifecycleEpoch;
    const ownsAttempt = () => attempt === this.lifecycleEpoch;
    try {
      await this.ensureStarted();
      if (!ownsAttempt()) return { status: this.snapshot() };
      if (this.state !== "connected") {
        await this.refreshServerStatus(this.generation);
      }
      if (!ownsAttempt()) return { status: this.snapshot() };
      if (this.state === "needs_auth" && this.client && this.threadId) {
        const client = this.client;
        const threadId = this.threadId;
        const response = await client.request(
          "mcpServer/oauth/login",
          { threadId, name: FIGMA_REMOTE_SERVER_NAME },
          this.deps.timeouts.oauthLogin,
        );
        // A disconnect (or restart) mid-OAuth makes any returned URL stale.
        if (!ownsAttempt() || this.client !== client || this.threadId !== threadId)
          return { status: this.snapshot() };
        const url = validateFigmaAuthorizationUrl(
          isRecord(response) ? response.authorizationUrl : undefined,
        );
        return { status: this.snapshot(), ...(url ? { authorizationUrl: url } : {}) };
      }
      return { status: this.snapshot() };
    } catch (error) {
      if (!ownsAttempt()) return { status: this.snapshot() };
      if (isUnknownMethodError(error)) {
        this.state = "unavailable";
        this.stateMessage =
          "This Codex version does not support native MCP OAuth login. Update Codex (requires 0.165+).";
      } else if (this.state !== "unavailable") {
        this.state = "error";
        this.stateMessage = error instanceof Error ? error.message : String(error);
      }
      return { status: this.snapshot() };
    }
  }

  /** Disable + dispose the owned process/pending OAuth only — never logs out other Codex clients. */
  async disconnect(): Promise<void> {
    await this.saveEnabled(false);
    await this.stopOwned();
  }

  async dispose(): Promise<void> {
    await this.stopOwned();
  }

  // ── native observation ──────────────────────────────────────────────────────────

  /** State advances only from actual native notifications/status, never from wishes. */
  private onNotification(generation: number, method: string, params: unknown): void {
    if (generation !== this.generation || !this.client) return;
    if (method === "mcpServer/startupStatus/updated") {
      if (!isRecord(params) || params.name !== FIGMA_REMOTE_SERVER_NAME) return;
      const status = String(params.status ?? "");
      if (status === "failed") {
        this.state = "error";
        this.stateMessage = "The official Figma MCP server failed to start in Codex.";
      } else if (status === "starting") {
        this.state = "connecting";
      }
      void this.refreshServerStatus(generation);
      return;
    }
    if (method === "mcpServer/oauthLogin/completed") {
      if (!isRecord(params) || params.name !== FIGMA_REMOTE_SERVER_NAME) return;
      void this.refreshServerStatus(generation);
    }
  }

  /**
   * The authoritative native status read, single-flight: notification-triggered refreshes,
   * start-up refreshes, and status polls share one `mcpServerStatus/list` at a time, each
   * bounded by the serverStatus timeout. Never starts a process, never touches OAuth. An
   * in-flight refresh from a dead generation is never joined — it would guard-drop its result.
   */
  private refreshServerStatus(generation: number): Promise<void> {
    if (this.statusRefresh && this.statusRefreshGeneration === generation)
      return this.statusRefresh;
    const refresh = this.refreshServerStatusNow(generation).finally(() => {
      if (this.statusRefresh === refresh) this.statusRefresh = null;
    });
    this.statusRefresh = refresh;
    this.statusRefreshGeneration = generation;
    return refresh;
  }

  /** The authoritative read of runtime status + real tool inventory for the official endpoint. */
  private async refreshServerStatusNow(generation: number): Promise<void> {
    const client = this.client;
    const threadId = this.threadId;
    if (!client || !threadId) return;
    let response: unknown;
    try {
      response = await client.request(
        "mcpServerStatus/list",
        { threadId, serverName: FIGMA_REMOTE_SERVER_NAME, detail: "toolsAndAuthOnly" },
        this.deps.timeouts.serverStatus,
      );
    } catch (error) {
      // A stale observation from a dead generation must not touch state at all — including
      // the unknown-method branch, so old -32601 noise cannot mark a reconnect unavailable.
      if (!this.owns(generation) || this.client !== client) return;
      if (isUnknownMethodError(error)) {
        this.state = "unavailable";
        this.stateMessage =
          "This Codex version does not support native MCP status. Update Codex (requires 0.165+).";
        return;
      }
      this.state = "error";
      this.stateMessage = error instanceof Error ? error.message : String(error);
      return;
    }
    if (!this.owns(generation) || this.client !== client) return;
    const data = isRecord(response) && Array.isArray(response.data) ? response.data : [];
    const entry = data.find((item) => isRecord(item) && item.name === FIGMA_REMOTE_SERVER_NAME);
    if (!isRecord(entry)) {
      this.state = "error";
      this.stateMessage = "The official Figma MCP server is not listed by Codex.";
      return;
    }
    const runtimeStatus = String(entry.runtimeStatus ?? "");
    const authStatus = String(entry.authStatus ?? "unknown");
    const tools = isRecord(entry.tools) ? entry.tools : {};
    if (authStatus === "notLoggedIn") {
      this.state = "needs_auth";
      this.stateMessage = "Connect editing to sign in to Figma in the browser on this machine.";
      this.tools = {};
      return;
    }
    if (runtimeStatus === "connected") {
      this.state = "connected";
      this.stateMessage = undefined;
      this.tools = tools;
      void this.refreshIdentity(generation);
      return;
    }
    if (runtimeStatus === "starting") {
      this.state = "connecting";
      return;
    }
    this.state = "error";
    this.stateMessage = `The official Figma MCP server reported "${runtimeStatus || "unknown"}".`;
  }

  /**
   * Identity is cosmetic: a failed whoami must never change the observed state. Attempted
   * once per lifecycle generation — otherwise every status poll would enqueue another whoami
   * behind the serialized write lane and backlog live writes.
   */
  private refreshIdentity(generation: number): Promise<void> {
    const client = this.client;
    if (!client || !Object.hasOwn(this.tools, "whoami")) return Promise.resolve();
    if (generation !== this.generation || this.identityAttemptedGeneration === generation)
      return Promise.resolve();
    this.identityAttemptedGeneration = generation;
    return this.attemptIdentity(generation, client);
  }

  private async attemptIdentity(generation: number, client: NativeMcpRpcClient): Promise<void> {
    try {
      // Queued like every other tool call so a whoami elicitation can never be attributed
      // to (or steal the flag from) a concurrent write. Elicitations here are ignorable.
      const response = await this.enqueue(() =>
        this.dispatchToolCall(generation, client, "whoami", {}, { tolerateElicitation: true }),
      );
      // Final ownership gate after the await: a dead lifecycle never sets identity.
      if (this.owns(generation) && this.client === client) {
        this.identityText = figmaIdentityLabel(extractFirstText(response));
      }
    } catch {
      // best-effort
    }
  }

  // ── reads and writes ────────────────────────────────────────────────────────────

  async readMetadata(fileKey: string, nodeId?: string): Promise<FigmaRemoteCallResult> {
    this.requireConnectedForCall();
    const tool = this.tools.get_metadata;
    if (!toolAdvertisesParameters(tool, ["fileKey"])) {
      throw new Error(
        "The official Figma MCP server does not advertise get_metadata with a fileKey parameter in its actual inventory.",
      );
    }
    return this.callTool("get_metadata", { fileKey, ...(nodeId ? { nodeId } : {}) });
  }

  async execute(input: FigmaRemoteExecuteInput): Promise<FigmaRemoteExecuteOutcome> {
    this.requireConnectedForCall();
    const codeBytes = Buffer.byteLength(input.code, "utf8");
    if (codeBytes === 0 || codeBytes > FIGMA_REMOTE_MAX_CODE_BYTES) {
      throw new Error(
        `use_figma code must be 1..${FIGMA_REMOTE_MAX_CODE_BYTES} UTF-8 bytes (got ${codeBytes}).`,
      );
    }
    const descriptionLength = input.description.trim().length;
    if (
      descriptionLength < FIGMA_REMOTE_DESCRIPTION_MIN ||
      descriptionLength > FIGMA_REMOTE_DESCRIPTION_MAX
    ) {
      throw new Error(
        `use_figma description must be ${FIGMA_REMOTE_DESCRIPTION_MIN}..${FIGMA_REMOTE_DESCRIPTION_MAX} characters.`,
      );
    }
    const tool = this.tools.use_figma;
    if (!toolAdvertisesParameters(tool, ["fileKey", "code"])) {
      throw new Error(
        "The official Figma MCP server does not advertise use_figma with fileKey and code parameters in its actual inventory.",
      );
    }
    // The daemon injects the target fileKey at the tool layer; the caller cannot swap endpoint or tool.
    const result = await this.callTool(
      "use_figma",
      {
        fileKey: input.fileKey,
        code: input.code,
        description: input.description,
        skillNames: "figma-use",
      },
      // A malformed reply to a dispatched write is unknown-outcome (memo drop), not success.
      { postDispatchMalformedIsUnknown: true },
    );
    let readback: FigmaRemoteCallResult | undefined;
    let readbackAvailable = false;
    if (!result.isError) {
      try {
        readback = await this.readMetadata(input.fileKey);
        readbackAvailable = !readback.isError;
      } catch {
        readback = undefined;
        readbackAvailable = false;
      }
    }
    return { result, readbackAvailable, ...(readback ? { readback } : {}) };
  }

  private requireConnectedForCall(): void {
    if (this.state === "connected" && this.client && this.threadId) return;
    const guidance = this.callGuidance();
    throw new Error(`Figma remote editing is ${this.state}. ${guidance}`);
  }

  /** The one recovery line shown with a guard error — no retry, no LLM fallback. */
  private callGuidance(): string {
    if (this.state === "needs_auth" || !this.enabled)
      return 'Ask the user to tap "Connect editing".';
    if (this.state === "unavailable") return "Update Codex on this host.";
    return "Retry Connect editing.";
  }

  private async callTool(
    tool: string,
    args: Record<string, unknown>,
    options: { postDispatchMalformedIsUnknown?: boolean } = {},
  ): Promise<FigmaRemoteCallResult> {
    const generation = this.generation;
    const client = this.client;
    if (!client || !this.threadId) throw new Error("Figma remote editing is disconnected.");
    const response = await this.enqueue(() =>
      this.dispatchToolCall(generation, client, tool, args, {}),
    );
    try {
      return this.parseCallResult(tool, response);
    } catch (error) {
      // The call was already DISPATCHED: a malformed reply to a write cannot claim success
      // — the side effect may have landed, so surface it like any other unknown outcome.
      // Reads keep the plain failure (no write classification).
      if (options.postDispatchMalformedIsUnknown && error instanceof Error)
        throw new FigmaRemoteOutcomeUnknownError(
          `${error.message} Treat the write outcome as unverified.`,
          { cause: error },
        );
      throw error;
    }
  }

  /**
   * One dispatched `mcpServer/tool/call` at a time. Without this, concurrent calls (two agents,
   * a readback, a whoami) would share the single `activeCall` slot and a native approval for an
   * earlier write could be recorded on — or swallowed by — a later call. Each call enters and
   * leaves through here, so execute→readback chains stay sequential and never self-deadlock.
   */
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.toolQueue.then(run, run);
    this.toolQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async dispatchToolCall(
    generation: number,
    client: NativeMcpRpcClient,
    tool: string,
    args: Record<string, unknown>,
    options: { tolerateElicitation?: boolean },
  ): Promise<unknown> {
    // Queued time counts: ownership can be lost before we are ever dispatched.
    if (!this.owns(generation) || this.client !== client)
      throw new FigmaRemoteOutcomeUnknownError(
        "The Figma editing helper restarted during the write; outcome unverified.",
      );
    const threadId = this.threadId;
    if (!threadId) throw new Error("Figma remote editing is disconnected.");
    const call = { tool, elicited: false };
    this.activeCall = call;
    let response: unknown;
    try {
      response = await client.request(
        "mcpServer/tool/call",
        { threadId, server: FIGMA_REMOTE_SERVER_NAME, tool, arguments: args },
        this.deps.timeouts.toolCall,
      );
    } catch (error) {
      if (!this.owns(generation)) {
        // Late callback after a dispose/restart: the write outcome is unknown, never auto-retried.
        throw new FigmaRemoteOutcomeUnknownError(
          "The Figma editing helper restarted during the write; outcome unverified.",
          { cause: error },
        );
      }
      if (isTimeoutError(error)) {
        throw new FigmaRemoteOutcomeUnknownError(
          `The Figma editing helper timed out responding to ${tool}; outcome unverified.`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      if (this.activeCall === call) this.activeCall = null;
    }
    if (!this.owns(generation) || this.client !== client) {
      throw new FigmaRemoteOutcomeUnknownError(
        "The Figma editing helper restarted during the write; outcome unverified.",
      );
    }
    if (call.elicited && !options.tolerateElicitation) {
      throw new FigmaRemoteOutcomeUnknownError(
        `The official Figma MCP server asked for an approval while calling ${tool}; ` +
          "the connector declined it and treats the outcome as unverified. Check the file in the viewer.",
      );
    }
    return response;
  }

  /**
   * Fail closed: a native result that is not a well-formed MCP tool result must never surface
   * as an empty success. `isError` stays a strict boolean when present.
   */
  private parseCallResult(tool: string, response: unknown): FigmaRemoteCallResult {
    const malformed = () =>
      new Error(`The official Figma MCP server returned a malformed ${tool} result.`);
    if (!isRecord(response) || !Array.isArray(response.content)) throw malformed();
    if (response.isError !== undefined && typeof response.isError !== "boolean") throw malformed();
    for (const block of response.content) {
      if (!isRecord(block) || typeof block.type !== "string") throw malformed();
    }
    return {
      content: response.content as FigmaRemoteCallResult["content"],
      ...(response.structuredContent !== undefined
        ? { structuredContent: response.structuredContent }
        : {}),
      ...(response.isError !== undefined ? { isError: response.isError as boolean } : {}),
    };
  }
}

function extractFirstText(response: unknown): string | undefined {
  if (!isRecord(response) || !Array.isArray(response.content)) return undefined;
  for (const block of response.content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text) {
      return block.text;
    }
  }
  return undefined;
}

// ── the real transport ────────────────────────────────────────────────────────────

const OPENAI_AUTH_ENV_KEYS = [
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "OPENAI_AUTH_TOKEN",
  "ACCESS_TOKEN",
] as const;

async function spawnCodexAppServer(
  codexHome: string,
  workDir: string,
): Promise<NativeMcpRpcClient> {
  const launch = await resolveProviderLaunch({
    defaultBinary: { command: "codex", resolvePath: findDefaultCodexBinary },
  });
  const availability = await checkProviderLaunchAvailable(launch, {
    command: "codex",
    resolvePath: findDefaultCodexBinary,
  });
  if (!availability.available) {
    throw new Error(
      "The Codex CLI is required to edit Figma files from chat. Install or update Codex (requires 0.165+).",
    );
  }
  const connectorCodexHome = codexHome;
  await mkdir(connectorCodexHome, { recursive: true, mode: 0o700 });
  ensurePrivateDirectory(connectorCodexHome);
  await mkdir(workDir, { recursive: true, mode: 0o700 });
  const connectorEnv: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: connectorCodexHome };
  for (const key of OPENAI_AUTH_ENV_KEYS) delete connectorEnv[key];
  const command =
    launch.source === "override" ? launch.command : (availability.resolvedPath ?? launch.command);
  const child = spawnProcess(
    command,
    [
      ...launch.args,
      "app-server",
      "-c",
      "mcp_servers={}",
      "-c",
      "plugins={}",
      // The private CODEX_HOME dir also keeps native Figma OAuth tokens out of the shared OS
      // keyring; the file store is created, owned, and read by Codex alone (ADR-0040).
      "-c",
      "mcp_oauth_credentials_store=file",
    ],
    {
      cwd: workDir,
      env: connectorEnv,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("Codex app-server started without pipe stdio");
  }
  // The pipe guard above proves the streams; ChildProcess's types do not narrow themselves.
  return new CodexAppServerClient(child as never, connectorLogger());
}

let cachedLogger: Logger | null = null;
function connectorLogger(): Logger {
  if (!cachedLogger) {
    cachedLogger = pino({ level: "warn" }).child({ module: "figma-remote-app-server" });
  }
  return cachedLogger;
}
