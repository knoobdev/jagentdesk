import type { ProviderJAgentDeskToolsPolicy } from "@jagentdesk/protocol/provider-config";
import { isJAgentDeskToolEnabled } from "../jagentdesk-tool-policy.js";
import { z } from "zod";
import type { AgentManager } from "../agent-manager.js";
import type { JAgentDeskToolDefinition } from "./types.js";
import { addModelVisibleStructuredContent } from "./jagentdesk-tool-serialization.js";

export function registerPluginTools(options: {
  agentManager: AgentManager;
  callerAgentId?: string;
  scope: "agent" | "top-level";
  tools: Map<string, JAgentDeskToolDefinition>;
  builtinNames: Set<string>;
  policy?: ProviderJAgentDeskToolsPolicy;
}): void {
  const { agentManager, callerAgentId, scope, tools, builtinNames } = options;
  if (scope !== "agent" || !callerAgentId) return;
  for (const tool of agentManager.getPluginTools(callerAgentId)) {
    if (builtinNames.has(tool.name)) {
      throw new Error(
        `Agent tool ${tool.name} from plugin ${tool.pluginId} collides with JAgentDesk tool ${tool.name}`,
      );
    }
    if (!isJAgentDeskToolEnabled(options.policy, tool.name)) continue;
    tools.set(tool.name, {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: z.fromJSONSchema(tool.inputSchema),
      async handler(input, { signal }) {
        const result = await agentManager.executePluginTool(tool, callerAgentId, input, signal);
        return addModelVisibleStructuredContent({
          content: result.text === undefined ? [] : [{ type: "text", text: result.text }],
          structuredContent: result.structuredContent,
          isError: result.isError,
        });
      },
    });
  }
}
