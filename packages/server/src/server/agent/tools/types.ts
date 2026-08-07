import type { z } from "zod";

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
}

export interface JAgentDeskToolDefinition extends JAgentDeskToolConfig {
  name: string;
  description: string;
  handler: (input: unknown, context: JAgentDeskToolExecutionContext) => Promise<JAgentDeskToolResult>;
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
  callerAgentId?: string;
  enableVoiceTools?: boolean;
  voiceOnly?: boolean;
}

export type JAgentDeskToolCatalogFactory = (
  context: JAgentDeskToolRuntimeContext,
) => JAgentDeskToolCatalog | Promise<JAgentDeskToolCatalog>;
