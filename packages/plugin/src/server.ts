import type { PluginAttachmentSourceContribution } from "./contracts.js";

export {
  PluginAttachmentItemSchema,
  PluginAttachmentSearchPayloadSchema,
  type PluginAttachmentItem,
  type PluginAttachmentSearchPayload,
} from "./attachments.js";
export type { PluginAttachmentSourceContribution, PluginHandlerContext } from "./contracts.js";
export { defineRpc, type PluginRpcContract } from "./rpc.js";
// Server-safe settings helpers (pure: zod + defineRpc) so server-side plugins that call
// defineSettings/settingsRpc load through the plugin subprocess runtime.
export { defineSettings, settingsRpc, type SettingsDefinition } from "./settings.js";

export function defineAttachmentSource<Definition extends PluginAttachmentSourceContribution>(
  definition: Definition,
): Definition {
  return definition;
}
