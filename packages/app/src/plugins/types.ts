import type { QueryClient } from "@tanstack/react-query";
import type {
  PluginAttachmentSourceContribution,
  PluginCommandCenterItemContribution,
  PluginSettingsScreenContribution,
  PluginSidebarContribution,
  PluginSurfaceContribution,
  PluginThemeContribution,
  PluginPanelLocation,
  PluginWorkspacePanelContribution,
} from "@jagentdesk/plugin";

export type EvaluatedPluginWorkspacePanelContribution = PluginWorkspacePanelContribution & {
  locations: readonly PluginPanelLocation[];
};

export interface EvaluatedPlugin {
  id: string;
  cleanup: () => void;
  surfaces: PluginSurfaceContribution[];
  settingsScreens: PluginSettingsScreenContribution[];
  sidebarItems: PluginSidebarContribution[];
  workspacePanels: EvaluatedPluginWorkspacePanelContribution[];
  commandCenterItems: PluginCommandCenterItemContribution[];
  attachmentSources: PluginAttachmentSourceContribution[];
  themes: PluginThemeContribution[];
}

export interface InstalledPlugin extends EvaluatedPlugin {
  serverId: string;
  clientBundle: string;
  queryClient: QueryClient;
}

export type {
  PluginAttachmentSourceContribution,
  PluginCommandCenterItemContribution,
  PluginSettingsScreenContribution,
  PluginSidebarContribution,
  PluginSurfaceContribution,
  PluginThemeContribution,
  PluginWorkspacePanelContribution,
};
