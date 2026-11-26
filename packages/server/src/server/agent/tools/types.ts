import type { ProviderJAgentDeskToolsPolicy } from "@jagentdesk/protocol/provider-config";
import type { z } from "zod";

export class JAgentDeskToolInputError extends Error {
  readonly status = 400;
  readonly issues?: z.ZodError["issues"];

  constructor(message: string, issues?: z.ZodError["issues"]) {
    super(message);
    this.issues = issues;
    this.name = "JAgentDeskToolInputError";
  }
}

export interface JAgentDeskToolExecutionContext {
  signal?: AbortSignal;
  sendUpdate?: (update: JAgentDeskToolResult) => void;
}

export interface JAgentDeskToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface JAgentDeskToolConfig {
  title?: string;
  description?: string;
  inputSchema?: z.ZodRawShape | z.ZodType;
  outputSchema?: z.ZodRawShape;
  /** MCP tool `_meta`, passed through to MCP clients. */
  _meta?: Record<string, unknown>;
}

export interface JAgentDeskToolDefinition extends JAgentDeskToolConfig {
  name: string;
  description: string;
  handler: (
    input: unknown,
    context: JAgentDeskToolExecutionContext,
  ) => Promise<JAgentDeskToolResult>;
}

export interface JAgentDeskToolCatalog {
  tools: ReadonlyMap<string, JAgentDeskToolDefinition>;
  getTool(name: string): JAgentDeskToolDefinition | undefined;
  executeTool(
    name: string,
    input: unknown,
    context?: JAgentDeskToolExecutionContext,
  ): Promise<JAgentDeskToolResult>;
}

export interface JAgentDeskToolRuntimeContext {
  callerAgentLabels?: Record<string, string>;
  jagentdeskToolPolicy?: ProviderJAgentDeskToolsPolicy;
  callerAgentId?: string;
  enableVoiceTools?: boolean;
  voiceOnly?: boolean;
}

export type JAgentDeskToolCatalogFactory = (
  context: JAgentDeskToolRuntimeContext,
) => JAgentDeskToolCatalog | Promise<JAgentDeskToolCatalog>;
