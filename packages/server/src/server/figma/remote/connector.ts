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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only an official Figma HTTPS URL may be handed to the app's browser-open button (32.2 rule). */
export function validateFigmaAuthorizationUrl(url: unknown): string | undefined {
  if (typeof url !== "string" || !url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") return undefined;
  const host = parsed.hostname;
  if (host !== "figma.com" && !host.endsWith(".figma.com")) return undefined;
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
  private state: FigmaRemoteStatus["state"] = "disconnected";
  private stateMessage: string | undefined;
  private identityText: string | undefined;
  private tools: Record<string, unknown> = {};
  /** Count of native elicitations observed; exposed for focused tests and diagnostics. */
  elicitationCount = 0;
  private activeCall: { tool: string; elicited: boolean } | null = null;

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

  /** Reflects only observed native events/status. Never starts the process, never opens OAuth. */
  async getStatus(): Promise<FigmaRemoteStatus> {
    const enabled = await this.loadEnabled();
    // When the connector is off, the persisted flag wins: error/unavailable only
    // describe a process the daemon actually owned.
    if (!enabled) return { state: "disconnected" };
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
      this.starting = this.startOnce().finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private async startOnce(): Promise<void> {
    this.state = "connecting";
    this.stateMessage = undefined;
    const generation = ++this.generation;
    let client: NativeMcpRpcClient;
    try {
      client = await this.deps.createClient();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state = "unavailable";
      this.stateMessage = message;
      return;
    }
    client.setNotificationHandler((method, params) =>
      this.onNotification(generation, method, params),
    );
    // An elicitation the connector cannot answer semantically must fail the call clear —
    // never blanket-accept an approval request that was not ours to grant.
    client.setRequestHandler("mcpServer/elicitation/request", (params) => {
      this.elicitationCount++;
      if (this.activeCall) {
        this.activeCall.elicited = true;
      }
      this.deps.logger.debug({ params }, "figma remote elicitation declined");
      return { action: "decline", content: null };
    });
    client.setUnexpectedTerminationHandler(() => {
      if (generation !== this.generation) return;
      // No automatic retry: a dropped child leaves the last execute's outcome unknown.
      this.client = null;
      this.threadId = null;
      this.tools = {};
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
      const threadId =
        isRecord(started) && isRecord(started.thread) ? started.thread.id : undefined;
      if (typeof threadId !== "string" || !threadId) {
        throw new Error("Codex did not create the editing thread");
      }
      this.client = client;
      this.threadId = threadId;
    } catch (error) {
      await client.dispose().catch(() => {});
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
    this.state = "disconnected";
    this.stateMessage = undefined;
    this.identityText = undefined;
    if (client) await client.dispose().catch(() => {});
  }

  /** Explicit native OAuth. Returns the validated Figma HTTPS URL for the app's browser button. */
  async authBegin(): Promise<{ status: FigmaRemoteStatus; authorizationUrl?: string }> {
    await this.saveEnabled(true);
    try {
      await this.ensureStarted();
      if (this.state !== "connected") {
        await this.refreshServerStatus(this.generation);
      }
      if (this.state === "needs_auth" && this.client && this.threadId) {
        const response = await this.client.request(
          "mcpServer/oauth/login",
          { threadId: this.threadId, name: FIGMA_REMOTE_SERVER_NAME },
          this.deps.timeouts.oauthLogin,
        );
        const url = validateFigmaAuthorizationUrl(
          isRecord(response) ? response.authorizationUrl : undefined,
        );
        return { status: this.snapshot(), ...(url ? { authorizationUrl: url } : {}) };
      }
      return { status: this.snapshot() };
    } catch (error) {
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

  /** The authoritative read of runtime status + real tool inventory for the official endpoint. */
  private async refreshServerStatus(generation: number): Promise<void> {
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
      if (isUnknownMethodError(error)) {
        this.state = "unavailable";
        this.stateMessage =
          "This Codex version does not support native MCP status. Update Codex (requires 0.165+).";
        return;
      }
      if (generation === this.generation && this.client === client) {
        this.state = "error";
        this.stateMessage = error instanceof Error ? error.message : String(error);
      }
      return;
    }
    if (generation !== this.generation || this.client !== client) return;
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

  /** Identity is cosmetic: a failed whoami must never change the observed state. */
  private async refreshIdentity(generation: number): Promise<void> {
    const client = this.client;
    const threadId = this.threadId;
    if (!client || !threadId || !Object.hasOwn(this.tools, "whoami")) return;
    try {
      const response = await client.request(
        "mcpServer/tool/call",
        { threadId, server: FIGMA_REMOTE_SERVER_NAME, tool: "whoami", arguments: {} },
        this.deps.timeouts.toolCall,
      );
      if (generation !== this.generation || this.client !== client) return;
      const text = extractFirstText(response);
      if (text) this.identityText = text.slice(0, 500);
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
    const result = await this.callTool("use_figma", {
      fileKey: input.fileKey,
      code: input.code,
      description: input.description,
      skillNames: "figma-use",
    });
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
  ): Promise<FigmaRemoteCallResult> {
    const generation = this.generation;
    const client = this.client;
    const threadId = this.threadId;
    if (!client || !threadId) throw new Error("Figma remote editing is disconnected.");
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
      if (generation !== this.generation) {
        // Late callback after a dispose/restart: the write outcome is unknown, never auto-retried.
        throw new Error(
          "The Figma editing helper restarted during the write; outcome unverified.",
          { cause: error },
        );
      }
      throw error;
    } finally {
      if (this.activeCall === call) this.activeCall = null;
    }
    if (generation !== this.generation || this.client !== client) {
      throw new Error("The Figma editing helper restarted during the write; outcome unverified.");
    }
    if (call.elicited) {
      throw new Error(
        `The official Figma MCP server asked for an approval while calling ${tool}; ` +
          "the connector declined it and treats the outcome as unverified. Check the file in the viewer.",
      );
    }
    const content =
      isRecord(response) && Array.isArray(response.content)
        ? (response.content as Array<Record<string, unknown>>)
        : [];
    return {
      content,
      ...(isRecord(response) && response.structuredContent !== undefined
        ? { structuredContent: response.structuredContent }
        : {}),
      ...(isRecord(response) && response.isError !== undefined
        ? { isError: Boolean(response.isError) }
        : {}),
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
