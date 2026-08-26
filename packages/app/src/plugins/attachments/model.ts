import { z } from "zod";
import type { AgentAttachment } from "@jagentdesk/protocol/messages";
import { PluginAttachmentItemSchema, type PluginAttachmentItem } from "@jagentdesk/plugin";
import type { UserComposerAttachment } from "@/attachments/types";

export const PluginResourceComposerAttachmentSchema = z.object({
  kind: z.literal("plugin_resource"),
  pluginId: z.string().min(1),
  sourceId: z.string().min(1),
  sourceTitle: z.string().min(1),
  sourceIcon: z.string().min(1),
  item: PluginAttachmentItemSchema,
});

export type PluginResourceComposerAttachment = z.infer<
  typeof PluginResourceComposerAttachmentSchema
>;

export interface PluginResourceSourceIdentity {
  pluginId: string;
  sourceId: string;
  sourceTitle: string;
  sourceIcon: string;
}

export function createPluginResourceAttachment(
  source: PluginResourceSourceIdentity,
  item: PluginAttachmentItem,
): PluginResourceComposerAttachment {
  return {
    kind: "plugin_resource",
    ...source,
    item,
  };
}

export function togglePluginResourceAttachment(
  current: UserComposerAttachment[],
  attachment: PluginResourceComposerAttachment,
): UserComposerAttachment[] {
  const matches = (candidate: UserComposerAttachment) =>
    candidate.kind === "plugin_resource" &&
    candidate.pluginId === attachment.pluginId &&
    candidate.sourceId === attachment.sourceId &&
    candidate.item.id === attachment.item.id;
  if (current.some(matches)) {
    return current.filter((candidate) => !matches(candidate));
  }
  return [...current, attachment];
}

// JAgentDesk's AgentAttachment text variant carries no external-resource metadata
// block (see TextAttachmentSchema), so the plugin resource is delivered to the
// agent as a titled text attachment rather than a typed external reference.
export function pluginResourceAttachmentToAgentAttachment(
  attachment: PluginResourceComposerAttachment,
): AgentAttachment {
  return {
    type: "text",
    mimeType: "text/plain",
    title: `${attachment.item.identifier} ${attachment.item.title}`,
    text: attachment.item.text,
  };
}
