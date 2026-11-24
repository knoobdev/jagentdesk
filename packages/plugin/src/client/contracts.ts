import type { PluginText } from "../text.js";
import type { PluginIconProps, PluginSerializableIcon } from "../icons.js";
import type { PluginFile, PluginFileLocation } from "./file.js";
import type { ComponentType } from "react";
import type { JAgentDeskApi } from "@jagentdesk/client";
import type { AgentTimelineItem, JsonValue } from "@jagentdesk/protocol/agent-types";
import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
import type {
  PluginRpcContract,
  PluginSubscribeOptions,
  PluginSubscriptionContract,
  PluginSubscriptionHandle,
  PluginWireInput,
} from "../rpc.js";
import type {
  PluginButtonRegistration,
  PluginHeaderButtonContribution,
  PluginComposerPillContribution,
} from "./buttons.js";
import type {
  PluginTheme,
  PluginWorkspaceSnapshot,
  PluginAgentSnapshot,
  PluginThemeContribution,
  PluginAttachmentSourceContribution,
  PluginTimelineTransformResult,
  PluginCleanup,
} from "../contracts.js";

export interface PluginHostProps {
  theme: PluginTheme;
  host: {
    id: string;
    label: string;
  };
  layout: {
    compact: boolean;
    platform: "ios" | "android" | "web";
  };
}

interface PluginNavigableHostProps extends PluginHostProps {
  /** Client-owned navigation. Undefined on older hosts; hide dependent affordances when absent. */
  readonly navigation?: {
    /** Present only on Electron. The browser runs locally; serverId selects workspace ownership. */
    readonly openBrowser?: (input: {
      readonly url: string;
      readonly workspaceId: string;
      readonly serverId?: string;
    }) => void;
    readonly openAgent: (input: { readonly agentId: string; readonly serverId?: string }) => void;
    readonly openWorkspace: (input: {
      readonly workspaceId: string;
      readonly serverId?: string;
    }) => void;
  };
}

export interface PluginSurfaceProps extends PluginNavigableHostProps {}

/** String keys and values: params travel in the screen's URL. */
export type PluginScreenParams = Record<string, string>;

export interface PluginOpenScreenInput {
  screenId: string;
  params?: PluginScreenParams;
}

export interface PluginScreenLocation {
  screenId: string;
  params: PluginScreenParams;
}

export interface PluginScreenProps extends PluginSurfaceProps {
  /** The params the screen was opened with; `{}` when none. */
  params: PluginScreenParams;
}

export interface PluginPopoverProps extends PluginHostProps {
  close(): void;
  openScreen(input: PluginOpenScreenInput): void;
}

export interface PluginSidebarItemProps extends PluginHostProps {
  /** This plugin's screen open on this item's host, with its params, else null. */
  currentScreen: PluginScreenLocation | null;
  openScreen(input: PluginOpenScreenInput): void;
  /** Anchored to the item on wide layouts; a bottom sheet on compact layouts. */
  openPopover(Content: ComponentType<PluginPopoverProps>): void;
}

export interface PluginSidebarItemContribution<Text extends PluginText = string> {
  id: string;
  /** Settings row label, accessibility label, and default label for SidebarRow. */
  title: Text;
  Component: ComponentType<PluginSidebarItemProps>;
}

export type PluginIcon<Props extends PluginIconProps = PluginIconProps> =
  | PluginSerializableIcon
  | ComponentType<Props>;
export type { PluginIconProps } from "../icons.js";

export type PluginPanelLocation = "workspace" | "explorer";

export interface PluginOpenPanelOptions {
  location?: PluginPanelLocation;
}

interface PluginWorkspacePanelBase<Text extends PluginText = string> {
  id: string;
  title: Text;
  icon: PluginIcon;
  locations?: readonly PluginPanelLocation[];
}

export interface PluginTab {
  setModified(modified: boolean): void;
  readonly state: unknown;
  setState(state: JsonValue): void;
}
export interface PluginPanelProps<Params> extends PluginNavigableHostProps {
  workspaceId: string;
  readonly params: Readonly<Params>;
  revision: number;
  tab: PluginTab;
}
export interface PluginWorkspacePanelParams {}
export interface PluginAgentPanelParams {
  readonly agentId: string;
}
export interface PluginFilePanelParams {
  readonly path: string;
  readonly lineStart?: number;
  readonly lineEnd?: number;
}
export interface PluginWorkspacePanelProps extends PluginPanelProps<PluginWorkspacePanelParams> {
  // COMPAT(pluginPanelFlatProps): added in v0.9.59, remove after 2027-04-23.
  context: "workspace";
}
export interface PluginAgentPanelProps extends PluginPanelProps<PluginAgentPanelParams> {
  // COMPAT(pluginPanelFlatProps): added in v0.9.59, remove after 2027-04-23.
  context: "agent";
  agentId: string;
}
export interface PluginFilePanelProps extends PluginPanelProps<PluginFilePanelParams> {
  file: PluginFile;
  // COMPAT(pluginFileLocation): added in v0.9.59, remove after 2027-04-23.
  location: PluginFileLocation;
}

export interface PluginFilePanelContribution<Text extends PluginText = string> {
  id: string;
  title: Text;
  icon: PluginIcon;
  /** Extensions without the dot, case-insensitive, and exact filenames. */
  files: { extensions: readonly string[]; filenames?: readonly string[] };
  Component: ComponentType<PluginFilePanelProps>;
}

export interface PluginClientOpenPanelOptions extends PluginOpenPanelOptions {
  workspaceId: string;
  agentId?: string;
}

export interface PluginClientContext extends PluginCommandCapabilities {
  readonly i18n: import("./translations.js").PluginI18n;
  /** Play a base64-encoded audio file on this client; resolves when playback ends. */
  playAudio(source: { base64: string; mimeType: string }): Promise<void>;
  addScreen(contribution: PluginScreenContribution<PluginText>): PluginCleanup;
  addSidebarHeaderItem(contribution: PluginSidebarItemContribution<PluginText>): PluginCleanup;
  addSidebarFooterItem(contribution: PluginSidebarItemContribution<PluginText>): PluginCleanup;
  addSettingsScreen(contribution: PluginSettingsScreenContribution<PluginText>): PluginCleanup;
  addSurface(id: string, Component: ComponentType<PluginSurfaceProps>): PluginCleanup;
  addSidebarItem(contribution: PluginSidebarContribution<PluginText>): PluginCleanup;
  addFilePanel(contribution: PluginFilePanelContribution<PluginText>): PluginCleanup;
  addAgentPanel(contribution: PluginAgentPanelContribution<PluginText>): PluginCleanup;
  addWorkspacePanel(contribution: PluginWorkspacePanelContribution<PluginText>): PluginCleanup;
  addCommandCenterItem(
    contribution: PluginCommandCenterItemContribution<PluginText>,
  ): PluginCleanup;
  addSlashCommand(contribution: PluginClientSlashCommandContribution<PluginText>): PluginCleanup;
  addHeaderButton(
    contribution: PluginHeaderButtonContribution<PluginText>,
  ): PluginButtonRegistration<PluginText>;
  addComposerPill(
    contribution: PluginComposerPillContribution<PluginText>,
  ): PluginButtonRegistration<PluginText>;
  addAttachmentSource(contribution: PluginAttachmentSourceContribution<PluginText>): PluginCleanup;
  addTheme(contribution: PluginThemeContribution<PluginText>): PluginCleanup;
  addTimelineTransformer<ItemType extends AgentTimelineItem["type"]>(
    contribution: PluginTimelineTransformerContribution<ItemType>,
  ): PluginCleanup;
  addTimelineRenderer<Schema extends ZodType>(
    contribution: PluginTimelineRendererContribution<Schema>,
  ): PluginCleanup;
  openPanel(id: string, options: PluginClientOpenPanelOptions): void;
  /**
   * Subscribes to a plugin subscription on this client's host. JAgentDesk re-subscribes after a
   * reconnect and releases what is left when the plugin stops.
   */
  subscribe<InputSchema extends ZodType, EventSchema extends ZodType>(
    contract: PluginSubscriptionContract<InputSchema, EventSchema>,
    input: PluginWireInput<ZodInput<InputSchema>>,
    onEvent: (event: ZodOutput<EventSchema>) => void,
    options?: PluginSubscribeOptions,
  ): PluginSubscriptionHandle;
}

export type PluginClientContribution = (client: PluginClientContext) => PluginCleanup;

export type PluginWorkspacePanelContribution<Text extends PluginText = string> =
  | (PluginWorkspacePanelBase<Text> & {
      context?: "workspace";
      Component: ComponentType<PluginWorkspacePanelProps>;
    })
  | (PluginWorkspacePanelBase<Text> & {
      context: "agent";
      Component: ComponentType<PluginAgentPanelProps>;
    });

export interface PluginAgentPanelContribution<
  Text extends PluginText = string,
> extends PluginWorkspacePanelBase<Text> {
  Component: ComponentType<PluginAgentPanelProps>;
}

export interface PluginSettingsScreenContribution<Text extends PluginText = string> {
  id: string;
  title: Text;
  icon: PluginIcon;
  Component: ComponentType<PluginSurfaceProps>;
}

/** The screen header's title: fixed, or derived from the params the screen was opened with. */
export type PluginScreenTitle<Text extends PluginText = string> =
  | Text
  | ((params: PluginScreenParams) => Text);

export interface PluginScreenContribution<Text extends PluginText = string> {
  id: string;
  title: PluginScreenTitle<Text>;
  Component: ComponentType<PluginScreenProps>;
}

export interface PluginSurfaceContribution<Text extends PluginText = string> {
  id: string;
  title?: PluginScreenTitle<Text>;
  Component: ComponentType<PluginScreenProps>;
}

export interface PluginSidebarContribution<Text extends PluginText = string> {
  id: string;
  title: Text;
  icon: PluginIcon;
  surface: string;
}

export type PluginTimelineTransformerContribution<
  ItemType extends AgentTimelineItem["type"] = AgentTimelineItem["type"],
> = ItemType extends AgentTimelineItem["type"]
  ? {
      id: string;
      query: {
        itemType: ItemType;
      };
      transform(input: {
        item: Extract<AgentTimelineItem, { type: ItemType }>;
        phase: "streaming" | "complete";
      }): PluginTimelineTransformResult | undefined;
    }
  : never;

export interface PluginTimelineItemProps<Data = unknown> extends PluginHostProps {
  agentId: string;
  item: {
    type: "plugin";
    kind: string;
    version: number;
    data: Data;
  };
  timestamp: Date;
}

export interface PluginTimelineRendererContribution<Schema extends ZodType = ZodType> {
  kind: string;
  version: number;
  schema: Schema;
  Component: ComponentType<PluginTimelineItemProps<ZodOutput<Schema>>>;
}

export interface PluginCommandCapabilities {
  jagentdesk: JAgentDeskApi;
  rpc<InputSchema extends ZodType, OutputSchema extends ZodType>(
    contract: PluginRpcContract<InputSchema, OutputSchema>,
    input: PluginWireInput<ZodInput<InputSchema>>,
  ): Promise<ZodOutput<OutputSchema>>;
  openScreen(input: PluginOpenScreenInput): void;
  openSurface(id: string): void;
  openSettings(id: string): void;
}

export interface PluginGlobalCommandContext extends PluginCommandCapabilities {
  context: "global";
}

export interface PluginWorkspaceCommandContext extends PluginCommandCapabilities {
  context: "workspace";
  workspace: PluginWorkspaceSnapshot;
  openPanel(id: string, options?: PluginOpenPanelOptions): void;
}

export interface PluginAgentCommandContext extends PluginCommandCapabilities {
  context: "agent";
  workspace: PluginWorkspaceSnapshot;
  agent: PluginAgentSnapshot;
  openPanel(id: string, options?: PluginOpenPanelOptions): void;
}

interface PluginCommandCenterItemBase<Text extends PluginText = string> {
  id: string;
  title: Text;
  icon: PluginIcon;
  keywords?: readonly string[];
}

export type PluginCommandCenterItemContribution<Text extends PluginText = string> =
  | (PluginCommandCenterItemBase<Text> & {
      context: "global";
      onSelect(context: PluginGlobalCommandContext): void | Promise<void>;
    })
  | (PluginCommandCenterItemBase<Text> & {
      context: "workspace";
      onSelect(context: PluginWorkspaceCommandContext): void | Promise<void>;
    })
  | (PluginCommandCenterItemBase<Text> & {
      context: "agent";
      onSelect(context: PluginAgentCommandContext): void | Promise<void>;
    });

interface PluginClientSlashCommandBase<Text extends PluginText = string> {
  name: string;
  description: Text;
  argumentHint: Text;
}

export type PluginClientSlashCommandContribution<Text extends PluginText = string> =
  | (PluginClientSlashCommandBase<Text> & {
      context: "workspace";
      onSubmit(context: PluginWorkspaceCommandContext & { args: string }): void | Promise<void>;
    })
  | (PluginClientSlashCommandBase<Text> & {
      context: "agent";
      onSubmit(context: PluginAgentCommandContext & { args: string }): void | Promise<void>;
    });

export type SettingsState<Schema extends ZodType> = (
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "invalid"; error: string; revision: string }
  | { status: "ready"; values: ZodOutput<Schema>; revision: string }
) & {
  saving: boolean;
  saveError: string | null;
  /** Save an entire document against the revision currently displayed. Never throws. */
  save(values: ZodOutput<Schema>, revision: string): Promise<boolean>;
  reset(): Promise<boolean>;
  reload(): Promise<void>;
};
