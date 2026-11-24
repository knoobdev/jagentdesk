import { type SettingsDefinition } from "../settings.js";
import { type SettingsState } from "./contracts.js";
import { type ZodType } from "zod";

export type {
  PluginHostProps,
  PluginWorkspaceRowBadgeItemProps,
  PluginWorkspaceRowBadgeItemContribution,
  PluginAgentPanelContribution,
  PluginTab,
  PluginPanelProps,
  PluginWorkspacePanelParams,
  PluginAgentPanelParams,
  PluginFilePanelParams,
  PluginFilePanelProps,
  PluginFilePanelContribution,
  PluginScreenProps,
  PluginScreenParams,
  PluginScreenLocation,
  PluginScreenTitle,
  PluginOpenScreenInput,
  PluginScreenContribution,
  PluginSidebarItemProps,
  PluginSidebarItemContribution,
  PluginPopoverProps,
  PluginSurfaceProps,
  PluginIconProps,
  PluginIcon,
  PluginPanelLocation,
  PluginOpenPanelOptions,
  PluginWorkspacePanelProps,
  PluginAgentPanelProps,
  PluginClientOpenPanelOptions,
  PluginClientContext,
  PluginClientContribution,
  PluginWorkspacePanelContribution,
  PluginSettingsScreenContribution,
  PluginSurfaceContribution,
  PluginSidebarContribution,
  PluginTimelineTransformerContribution,
  PluginTimelineItemProps,
  PluginTimelineRendererContribution,
  PluginCommandCapabilities,
  PluginGlobalCommandContext,
  PluginWorkspaceCommandContext,
  PluginAgentCommandContext,
  PluginCommandCenterItemContribution,
  PluginClientSlashCommandContribution,
  SettingsState,
} from "./contracts.js";

export type {
  PluginButton,
  PluginButtonBehavior,
  PluginButtonContentProps,
  PluginButtonContext,
  PluginButtonIcon,
  PluginButtonIconProps,
  PluginButtonMenuEntry,
  PluginButtonRegistration,
  PluginComposerPillContribution,
  PluginHeaderButtonContribution,
} from "./buttons.js";

export { useJAgentDesk } from "./jagentdesk-context.js";

export { useAgent, useWorkspace } from "./client-state.js";

export type {
  PluginComposer,
  PluginComposerAttachment,
  PluginComposerFocusOptions,
  PluginComposerItemContribution,
  PluginComposerItemProps,
  PluginComposerSelector,
} from "./composer.js";

export type {
  PluginNewWorkspace,
  PluginNewWorkspaceItemContribution,
  PluginNewWorkspaceItemProps,
} from "./new-workspace.js";

export type {
  PluginNewWorkspace,
  PluginNewWorkspaceItemContribution,
  PluginNewWorkspaceItemProps,
} from "./new-workspace.js";

export type {
  PluginComposer,
  PluginComposerAttachment,
  PluginComposerItemContribution,
  PluginComposerItemProps,
  PluginComposerSelector,
} from "./composer.js";

export { useRpc, useSubscription, type PluginSubscriptionState } from "./rpc-context.js";

export type {
  PluginSubscribeOptions,
  PluginSubscriptionClosed,
  PluginSubscriptionHandle,
} from "../rpc.js";

export declare function useSettings<Schema extends ZodType>(
  definition: SettingsDefinition<Schema>,
): SettingsState<Schema>;

/** Configured app host, including hosts that are currently disconnected. */
export interface PluginHostSummary {
  readonly serverId: string;
  readonly label: string;
  readonly status: "idle" | "connecting" | "online" | "offline" | "error";
}

/** Live configured hosts. Supplied by the app's client bundle loader. */
export declare function useHosts(): readonly PluginHostSummary[];

/** Borrow an online host's API under this installation's lifetime. */
export declare function getJAgentDeskClient(
  serverId: string,
): import("@jagentdesk/client").JAgentDeskApi;

/** Open an absolute HTTP(S) URL using the client platform’s external opener. */
export declare function openExternalUrl(url: string): Promise<void>;

export * from "./file.js";

export { useTabState } from "./tab.js";

export type { PluginI18n } from "./translations.js";

export type { PluginI18n } from "./translations.js";

export type { PluginText, PluginMessage, PluginTranslations } from "../text.js";
