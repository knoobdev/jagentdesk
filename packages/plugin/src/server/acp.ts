import type { JsonValue } from "@jagentdesk/protocol/agent-types";
import type {
  ProviderCatalog,
  ProviderCommand,
  ProviderConfigState,
  ProviderMode,
  ProviderNotice,
  ProviderPersistence,
  ProviderRegistration,
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "./provider.js";
import { createAcpProviderConnection } from "./acp-internal/connection.js";

interface RunAcpProviderBaseOptions {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  acpOptions?: AcpOptions;
  transformers?: readonly AcpTransformer[];
}

export type RunAcpProviderOptions = RunAcpProviderBaseOptions &
  (
    | { command: readonly [string, ...string[]]; connector?: never }
    | { connector: AcpConnector; command?: never }
  );

export type AcpStreamMessage =
  | { jsonrpc: "2.0"; id: string | number | null; method: string; params?: unknown }
  | { jsonrpc: "2.0"; method: string; params?: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | {
      jsonrpc: "2.0";
      id: string | number | null;
      error: { code: number; message: string; data?: unknown };
    };

export interface AcpStream {
  writable: WritableStream<AcpStreamMessage>;
  readable: ReadableStream<AcpStreamMessage>;
}

export type AcpConnector = () => AcpStream | Promise<AcpStream>;

export interface AcpOptions {
  deferTurnOnRunningTools?: {
    settleDelayMs?: number;
    quietLimitMs?: number;
    keepsTurnOpen?: (toolCall: AcpToolCallSnapshot) => boolean;
  };

  workspaceOnlyCatalog?: boolean;
  /** Publish session readiness after this much quiet time following replayed history. */
  loadReplayQuietPeriodMs?: number;
  autoAcceptMode?: {
    mode: Omit<ProviderMode, "isUnattended">;
    nativeMode: string;
    default?: boolean;
  };
  protocol?: "auto" | "v1";
  startupTimeoutMs?: number;
  waitForInitialCommands?: boolean;
  initialCommandsTimeoutMs?: number;
}

export interface AcpContext {
  sessionId: string;
}

export interface AcpConfigAccess {
  read(): Promise<Readonly<Record<string, JsonValue>>>;
  set(id: string, value: JsonValue): Promise<void>;
}

export type AcpRequest = (method: string, params: JsonValue) => Promise<JsonValue>;

export interface AcpDiscoveryContext extends AcpContext {
  config: AcpConfigAccess;
  request: AcpRequest;
}

export interface AcpConfigureContext extends AcpContext {
  catalog(): ProviderCatalog;
  apply(change: AcpConfigChange): Promise<void>;
  config: AcpConfigAccess;
  request: AcpRequest;
}

export type AcpConfigChange =
  | { target: "model"; value: string | null }
  | { target: "mode"; value: string | null }
  | { target: "thinking"; value: string | null }
  | { target: "setting"; id: string; value: JsonValue };

export interface AcpToolCallSnapshot {
  id: string;
  name?: string;
  title: string;
  kind?: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  input: JsonValue;
  output: JsonValue;
  locations: readonly string[];
  detail?: ProviderToolCallDetail;
}

export type AcpVendorUpdate =
  | { type: "commands"; commands: readonly ProviderCommand[] }
  | { type: "config"; config: ProviderConfigState }
  | { type: "timeline"; item: ProviderTimelineItem }
  | { type: "notice"; notice: ProviderNotice };

export interface AcpTransformer {
  /** Decode an older saved session and supply extension metadata for session/new or session/load. */
  sessionOpen?(context: {
    persistence?: ProviderPersistence;
    systemPrompt?: string;
    agentMetadata: JsonValue;
  }): { sessionId?: string; metadata?: Readonly<Record<string, JsonValue>> };

  discover?(
    catalog: ProviderCatalog,
    context: AcpDiscoveryContext,
  ): Promise<ProviderCatalog> | ProviderCatalog;
  configure?(change: AcpConfigChange, context: AcpConfigureContext): Promise<"handled" | "pass">;
  /** Rewrites every session config snapshot before JAgentDesk sees it. */
  config?(state: ProviderConfigState, context: AcpContext): ProviderConfigState;
  /** Rewrites each advertised ACP slash command before JAgentDesk sees it. */
  command?(command: ProviderCommand, context: AcpContext): ProviderCommand;
  notification?(
    notification: { method: string; params: JsonValue },
    context: AcpContext,
  ): AcpVendorUpdate | readonly AcpVendorUpdate[] | null;
  toolCall?(
    toolCall: AcpToolCallSnapshot,
    context: AcpContext & { mcpServerNames?: readonly string[] },
  ): AcpToolCallSnapshot;
}

export function runAcpProvider(options: RunAcpProviderOptions): ProviderRegistration {
  const hasCommand = options.command !== undefined;
  const hasConnector = options.connector !== undefined;
  if (hasCommand === hasConnector) {
    throw new Error("ACP provider requires exactly one command or SDK connector");
  }
  if (options.command && (options.command.length === 0 || options.command[0].trim().length === 0)) {
    throw new Error("ACP provider command must contain an executable");
  }
  return {
    id: options.id,
    label: options.label,
    description: options.description,
    icon: options.icon,
    command: options.command,
    connect(request) {
      return createAcpProviderConnection(options, request);
    },
  };
}
