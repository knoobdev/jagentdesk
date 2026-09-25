import { PluginAttachmentSearchPayloadSchema } from "../attachments.js";
export { PluginClientStateProvider, type PluginClientStateSource } from "./client-state.js";
export {
  usePluginRuntimeContextBridge,
  type PluginRuntimeContextBridge,
} from "./runtime-context-bridge.js";
import type { PluginAttachmentSourceContribution } from "../contracts.js";
import { PluginRpcProvider } from "./rpc-context.js";
import { JAgentDeskApiProvider } from "./jagentdesk-context.js";
import { callPluginRpc } from "../rpc.js";

export async function searchPluginAttachments(
  source: PluginAttachmentSourceContribution,
  invoke: (method: string, input: unknown) => Promise<unknown>,
  query: string,
) {
  const output = await callPluginRpc(source.search, invoke, { query });
  return PluginAttachmentSearchPayloadSchema.parseAsync(output);
}

export { callPluginRpc, JAgentDeskApiProvider, PluginRpcProvider };
