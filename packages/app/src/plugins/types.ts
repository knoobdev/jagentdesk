import { type QueryClient } from "@tanstack/react-query";
import { type PluginRequirements } from "@jagentdesk/protocol/messages";
import {
  type PluginAttachmentSourceContribution,
  type PluginCleanup,
  type PluginThemeContribution,
} from "@jagentdesk/plugin";
import {
  type PluginFilePanelContribution,
  type PluginSidebarItemContribution,
  type PluginCommandCenterItemContribution,
  type PluginClientSlashCommandContribution,
  type PluginComposerPillContribution,
  type PluginSidebarContribution,
  type PluginSurfaceContribution,
  type PluginSettingsScreenContribution,
  type PluginTimelineRendererContribution,
  type PluginTimelineTransformerContribution,
  type PluginNotificationOpenHandler,
  type PluginPanelLocation,
  type PluginWorkspacePanelContribution,
  type PluginComposerItemContribution,
  type PluginNewWorkspaceItemContribution,
} from "@jagentdesk/plugin/client";

export type EvaluatedPluginWorkspacePanelContribution = PluginWorkspacePanelContribution & {
  context: "workspace" | "agent";
  locations: readonly PluginPanelLocation[];
};

export interface EvaluatedPlugin {
  sidebarViews?: import("@jagentdesk/plugin/client").PluginSidebarViewContribution[];
  workspaceRowBadgeItems?: import("@jagentdesk/plugin/client").PluginWorkspaceRowBadgeItemContribution[];

  translations?: import("@jagentdesk/plugin/client/host").PluginTranslationRuntime;

  id: string;

  cleanup: PluginCleanup;

  surfaces: PluginSurfaceContribution[];

  settingsScreens: PluginSettingsScreenContribution[];

  sidebarItems: PluginSidebarContribution[];

  sidebarHeaderItems?: PluginSidebarItemContribution[];

  sidebarFooterItems?: PluginSidebarItemContribution[];

  filePanels?: PluginFilePanelContribution[];

  composerItems: PluginComposerItemContribution[];

  newWorkspaceItems: PluginNewWorkspaceItemContribution[];

  workspacePanels: EvaluatedPluginWorkspacePanelContribution[];

  commandCenterItems: PluginCommandCenterItemContribution[];

  clientSlashCommands: PluginClientSlashCommandContribution[];

  attachmentSources: PluginAttachmentSourceContribution[];

  themes: PluginThemeContribution[];

  timelineTransformers: PluginTimelineTransformerContribution[];

  timelineRenderers: PluginTimelineRendererContribution[];
  notificationOpenHandlers: PluginNotificationOpenHandler[];
}

export interface InstalledPlugin extends EvaluatedPlugin {
  lifetime: AbortController;
  /** Subscribes to one of the plugin's server subscriptions; released with the lifetime. */
  subscribe: import("@jagentdesk/plugin/client/host").PluginSubscribe;
  serverId: string;
  requirements?: PluginRequirements;
  clientBundle: string;
  queryClient: QueryClient;
}

export type {
  PluginFilePanelContribution,
  PluginAttachmentSourceContribution,
  PluginCommandCenterItemContribution,
  PluginClientSlashCommandContribution,
  PluginComposerItemContribution,
  PluginNewWorkspaceItemContribution,
  PluginComposerPillContribution,
  PluginSidebarContribution,
  PluginSidebarItemContribution,
  PluginSettingsScreenContribution,
  PluginThemeContribution,
  PluginTimelineRendererContribution,
  PluginTimelineTransformerContribution,
  PluginNotificationOpenHandler,
  PluginWorkspacePanelContribution,
};

export type { PluginSurfaceContribution };
