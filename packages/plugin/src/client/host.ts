import { PluginAttachmentSearchPayloadSchema } from "../attachments.js";
import { type PluginAttachmentSourceContribution } from "../contracts.js";
import { PluginRpcProvider } from "./rpc-context.js";
import { JAgentDeskApiProvider } from "./jagentdesk-context.js";
import { callPluginRpc, subscribePluginRpc, type PluginSubscriptionObserver } from "../rpc.js";

export { PluginClientStateProvider, type PluginClientStateSource } from "./client-state.js";

export {
  PluginComposerProvider,
  PluginComposersProvider,
  type PluginComposersSource,
} from "./composer.js";

export { PluginNewWorkspaceProvider } from "./new-workspace.js";

export {
  usePluginRuntimeContextBridge,
  type PluginRuntimeContextBridge,
} from "./runtime-context-bridge.js";

export async function searchPluginAttachments(
  source: PluginAttachmentSourceContribution,
  invoke: (method: string, input: unknown) => Promise<unknown>,
  query: string,
) {
  const output = await callPluginRpc(source.search, invoke, { query });
  return PluginAttachmentSearchPayloadSchema.parseAsync(output);
}

export { callPluginRpc, subscribePluginRpc, JAgentDeskApiProvider, PluginRpcProvider };

export type { PluginSubscriptionObserver };

export type { PluginSubscribe } from "./rpc-context.js";

export type { PluginLocaleSource } from "./translations.js";

export {
  PluginTranslationRuntime,
  PluginTranslationProvider,
  usePluginTranslationRuntime,
  requirePluginText,
  isPluginMessage,
} from "./translations.js";
