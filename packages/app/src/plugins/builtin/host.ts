import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react-native";
import type { BuiltinPluginId } from "@jagentdesk/protocol/builtin-plugins";
import type { PluginAttachmentSourceContribution, PluginTimelineItem } from "@jagentdesk/plugin";
import type { DaemonServerInfo } from "@/stores/session-store";
import type { ToolCallDetail } from "@jagentdesk/protocol/agent-types";
import type { StyleProp, TextStyle } from "react-native";
import type { SpecModeMessage } from "@jagentdesk/protocol/spec-mode";
import type { ActivityGraphNodeRef } from "@jagentdesk/protocol/agent-activity-graph";
import { builtinPluginEnabled } from "./registry";

export interface BuiltinClientProps {
  serverId: string;
}
export interface BuiltinDestination {
  id: string;
  title: string;
  /** Rail label and drill-in title; defaults to `title`. */
  shortTitle?: string;
  icon: LucideIcon;
  group: "Tools" | "main";
  route: (serverId: string) => string;
  routeSegment: string;
  /** Other host route segments that belong to this destination (list vs detail routes). */
  routeSegments?: readonly string[];
  /** Notifies when `route` would return a different value (for example a remembered resource). */
  routeChanges?: (listener: () => void) => () => void;
  /** Phase 1 daemons advertised some destinations with their own feature flag. */
  requiresFeature?: string;
  /** Shown only when the host reports at least one of these capabilities (spec 24.4). */
  hostCapabilities?: readonly import("@jagentdesk/protocol/host-capabilities").HostCapabilityId[];
  /** Legacy classic-sidebar row test id; defaults to `sidebar-<id>-nav`. */
  sidebarTestID?: string;
}
export interface BuiltinLeftPanelOptions {
  /** Replace the navigation list in the classic sidebar while this segment's route is open. */
  ownsNavigation?: boolean;
  /**
   * Behave like a core section (Servers, Jira): desktop only, and the panel also replaces the
   * Gumloop header. Without it the panel is a resource drill-in on desktop and mobile.
   */
  section?: boolean;
}
/** Renders a composer attachment of a core attachment kind owned by this feature. */
export interface BuiltinAttachmentPillProps {
  attachment: import("@/attachments/types").ComposerAttachment;
  index: number;
  disabled: boolean;
  onOpen: (attachment: import("@/attachments/types").ComposerAttachment) => void;
  onRemove: (index: number) => void;
}
export interface BuiltinAgentProps extends BuiltinClientProps {
  agentId: string;
}
export interface BuiltinComposerDockProps extends BuiltinAgentProps {
  cwd: string;
  onOpenFile: (absolutePath: string) => void;
}
export interface BuiltinSidePanelProps extends BuiltinAgentProps {
  onSelectNode: (nodeId: string, ref: ActivityGraphNodeRef) => void;
}
/**
 * A panel beside the agent chat: `panel` renders right of the chat on wide layouts (null while
 * closed), `sheet` renders on compact layouts.
 */
export interface BuiltinAgentSidePanel {
  panel: ComponentType<BuiltinSidePanelProps & { containerWidth: number }>;
  sheet: ComponentType<BuiltinSidePanelProps>;
}
/** A user message core parsed as a Spec mode phase command; core keeps copy and rewind text. */
export interface BuiltinUserMessageBodyProps {
  message: string;
  parsed: SpecModeMessage;
  textStyle: StyleProp<TextStyle>;
  textDataSet?: Record<string, string>;
}
/** Message fields a feature contributes when the user sends a turn. */
export interface BuiltinTurnPreparation {
  skillIds?: string[];
  /** Called once the daemon accepted the message. */
  commit(): void;
}
export type BuiltinTurnPreparer = (input: {
  serverId: string;
  agentId: string;
  text: string;
}) => BuiltinTurnPreparation;
export interface BuiltinScreen extends BuiltinClientProps {
  sshDocker?: import("@/ssh/ui/ssh-docker-client").SshDockerTarget;
  /** Set by route adapters that keep a blurred screen mounted but idle. */
  focused?: boolean;
}
/** `inline`: the chat timeline row. `details`: the expanded tool call sheet/panel. */
export type BuiltinToolCallPlacement = "inline" | "details";
export interface BuiltinToolCallCardProps<Match> {
  client: DaemonClient | null;
  toolName: string;
  match: Match;
  placement: BuiltinToolCallPlacement;
}
/** Replaces a tool call's generic rendering with a feature card when `match` recognizes it. */
export interface BuiltinToolCallRenderer<Match> {
  placements: readonly BuiltinToolCallPlacement[];
  match(toolName: string, detail: ToolCallDetail | undefined): Match | null;
  Card: ComponentType<BuiltinToolCallCardProps<Match>>;
}
export interface BuiltinClientHost {
  readonly id: BuiltinPluginId;
  sidebarDestination(destination: BuiltinDestination): void;
  leftPanel(
    routeSegment: string,
    component: ComponentType<BuiltinClientProps>,
    options?: BuiltinLeftPanelOptions,
  ): void;
  /** Rendered once per host route while the plugin is on (delegation prompts, binders). */
  hostMount(id: string, component: ComponentType<BuiltinClientProps>): void;
  screen(routeSegment: string, component: ComponentType<BuiltinScreen>): void;
  settingsSection(id: string, component: ComponentType<BuiltinClientProps>): void;
  /** A card on the host's Settings → Providers page, below the agent providers. */
  providerSettingsSection(id: string, component: ComponentType<BuiltinClientProps>): void;
  mobileDrawerEntry(destination: BuiltinDestination): void;
  composerItem(id: string, component: ComponentType<BuiltinClientProps>): void;
  timelineRenderer(
    kind: string,
    component: ComponentType<BuiltinClientProps & { item: PluginTimelineItem }>,
  ): void;
  attachmentSource(
    source: PluginAttachmentSourceContribution,
    search: BuiltinAttachmentSource["search"],
  ): void;
  toolCallRenderer<Match>(id: string, renderer: BuiltinToolCallRenderer<Match>): void;
  /** Composer pill for attachments of `kind`. */
  attachmentPill(kind: string, component: ComponentType<BuiltinAttachmentPillProps>): void;
  /** A control in the agent composer's control row, in plugin order. */
  agentControl(id: string, component: ComponentType<BuiltinAgentProps>): void;
  /** Rendered below an agent's conversation. */
  agentPanelAccessory(id: string, component: ComponentType<BuiltinAgentProps>): void;
  turnPreparer(prepare: BuiltinTurnPreparer): void;
  /** A control in the workspace screen header (Gumloop desktop shell). */
  workspaceHeaderControl(id: string, component: ComponentType<BuiltinClientProps>): void;
  /** A control in the agent chat header row, in plugin order. */
  agentHeaderControl(id: string, component: ComponentType<BuiltinAgentProps>): void;
  agentSidePanel(id: string, panel: BuiltinAgentSidePanel): void;
  /** Rendered above the agent composer input. */
  agentComposerDock(id: string, component: ComponentType<BuiltinComposerDockProps>): void;
  /**
   * A card in the host's Settings → Agents section. `order` keeps cards from several features
   * in their phase 1 sequence (browser opt-in 10, autorun 20, sharing 30, fingerprints 40).
   */
  agentSettingsCard(id: string, component: ComponentType<BuiltinClientProps>, order: number): void;
  /** Renders a parsed phase-command user message; one per host. */
  userMessageBody(component: ComponentType<BuiltinUserMessageBodyProps>): void;
}
export interface BuiltinAttachmentSource {
  source: PluginAttachmentSourceContribution;
  search(client: DaemonClient, input: unknown): Promise<unknown>;
}
export interface BuiltinClientContributions {
  destinations: BuiltinDestination[];
  mobileEntries: BuiltinDestination[];
  panels: Map<string, ComponentType<BuiltinClientProps>>;
  navigationPanels: Map<string, BuiltinLeftPanelOptions>;
  mounts: Map<string, ComponentType<BuiltinClientProps>>;
  screens: Map<string, ComponentType<BuiltinScreen>>;
  settings: Map<string, ComponentType<BuiltinClientProps>>;
  providerSettings: Map<string, ComponentType<BuiltinClientProps>>;
  composer: Map<string, ComponentType<BuiltinClientProps>>;
  timeline: Map<string, ComponentType<BuiltinClientProps & { item: PluginTimelineItem }>>;
  attachments: BuiltinAttachmentSource[];
  toolCalls: Map<string, BuiltinToolCallRenderer<unknown>>;
  pills: Map<string, ComponentType<BuiltinAttachmentPillProps>>;
  agentControls: Map<string, ComponentType<BuiltinAgentProps>>;
  agentPanel: Map<string, ComponentType<BuiltinAgentProps>>;
  turnPreparers: BuiltinTurnPreparer[];
  composerDocks: Map<string, ComponentType<BuiltinComposerDockProps>>;
  agentHeader: Map<string, ComponentType<BuiltinAgentProps>>;
  workspaceHeader: Map<string, ComponentType<BuiltinClientProps>>;
  sidePanels: Map<string, BuiltinAgentSidePanel>;
  userMessageBody: ComponentType<BuiltinUserMessageBodyProps> | null;
  agentSettings: Map<string, { component: ComponentType<BuiltinClientProps>; order: number }>;
}
export class BuiltinClientRegistry {
  private readonly entries = new Map<BuiltinPluginId, BuiltinClientContributions>();
  forPlugin(id: BuiltinPluginId): BuiltinClientHost {
    if (this.entries.has(id)) throw new Error(`Duplicate built-in client: ${id}`);
    const entry: BuiltinClientContributions = {
      destinations: [],
      mobileEntries: [],
      panels: new Map(),
      navigationPanels: new Map(),
      mounts: new Map(),
      screens: new Map(),
      settings: new Map(),
      providerSettings: new Map(),
      composer: new Map(),
      timeline: new Map(),
      attachments: [],
      toolCalls: new Map(),
      pills: new Map(),
      agentControls: new Map(),
      agentPanel: new Map(),
      turnPreparers: [],
      composerDocks: new Map(),
      agentHeader: new Map(),
      workspaceHeader: new Map(),
      sidePanels: new Map(),
      userMessageBody: null,
      agentSettings: new Map(),
    };
    this.entries.set(id, entry);
    const add = <T>(map: Map<string, T>, key: string, value: T) => {
      if (map.has(key)) throw new Error(`Duplicate built-in contribution: ${id}/${key}`);
      map.set(key, value);
    };
    return {
      id,
      sidebarDestination: (destination) => entry.destinations.push(destination),
      mobileDrawerEntry: (destination) => entry.mobileEntries.push(destination),
      leftPanel: (key, component, options) => {
        add(entry.panels, key, component);
        if (options?.ownsNavigation) entry.navigationPanels.set(key, options);
      },
      hostMount: (key, component) => add(entry.mounts, key, component),
      screen: (key, component) => add(entry.screens, key, component),
      settingsSection: (key, component) => add(entry.settings, key, component),
      providerSettingsSection: (key, component) => add(entry.providerSettings, key, component),
      composerItem: (key, component) => add(entry.composer, key, component),
      timelineRenderer: (key, component) => add(entry.timeline, key, component),
      attachmentSource: (source, search) => entry.attachments.push({ source, search }),
      toolCallRenderer: (key, renderer) =>
        add(entry.toolCalls, key, renderer as BuiltinToolCallRenderer<unknown>),
      attachmentPill: (kind, component) => add(entry.pills, kind, component),
      agentControl: (key, component) => add(entry.agentControls, key, component),
      agentPanelAccessory: (key, component) => add(entry.agentPanel, key, component),
      turnPreparer: (prepare) => entry.turnPreparers.push(prepare),
      agentComposerDock: (key, component) => add(entry.composerDocks, key, component),
      agentHeaderControl: (key, component) => add(entry.agentHeader, key, component),
      workspaceHeaderControl: (key, component) => add(entry.workspaceHeader, key, component),
      agentSidePanel: (key, panel) => add(entry.sidePanels, key, panel),
      agentSettingsCard: (key, component, order) =>
        add(entry.agentSettings, key, { component, order }),
      userMessageBody: (component) => {
        if (entry.userMessageBody) throw new Error(`Duplicate built-in message body: ${id}`);
        entry.userMessageBody = component;
      },
    };
  }
  /** Every consumer selects against live per-host state, including retained screens. */
  visible(
    info: DaemonServerInfo | null | undefined,
  ): ReadonlyMap<BuiltinPluginId, BuiltinClientContributions> {
    return new Map([...this.entries].filter(([id]) => builtinPluginEnabled(info, id)));
  }
  /** Destinations that drill the sidebar into the feature's own left panel. */
  destinations(): readonly BuiltinDestination[] {
    return [...this.entries.values()].flatMap((entry) => entry.destinations);
  }
  /**
   * Drill-in titles for every route segment of a destination whose feature registers a left
   * panel for it; other destinations keep the root navigation (Forge).
   */
  drillTitles(): readonly { routeSegment: string; title: string }[] {
    const segments = (destination: BuiltinDestination) => [
      destination.routeSegment,
      ...(destination.routeSegments ?? []),
    ];
    return this.destinations()
      .filter((destination) => segments(destination).some((segment) => this.hasPanel(segment)))
      .flatMap((destination) =>
        segments(destination).map((routeSegment) => ({
          routeSegment,
          title: destination.shortTitle ?? destination.title,
        })),
      );
  }
  hasPanel(routeSegment: string): boolean {
    return [...this.entries.values()].some((entry) => entry.panels.has(routeSegment));
  }
  /** `/h/<serverId>/<segment>…` routes whose panel replaces the classic sidebar navigation. */
  navigationPanelRoute(
    pathname: string,
  ): { serverId: string; segment: string; section: boolean } | null {
    const match = /^\/h\/([^/]+)\/([^/?]+)/.exec(pathname);
    if (!match) return null;
    const segment = match[2];
    const options = [...this.entries.values()]
      .map((entry) => entry.navigationPanels.get(segment))
      .find(Boolean);
    return options
      ? {
          serverId: decodeURIComponent(match[1]),
          segment,
          section: options.section === true,
        }
      : null;
  }
  hasPlugin(id: string): boolean {
    return [...this.entries.keys()].some((pluginId) => pluginId === id);
  }
  owner(routeSegment: string): BuiltinPluginId | undefined {
    return [...this.entries].find(([, entry]) => entry.screens.has(routeSegment))?.[0];
  }
  ownsLeftPanel(routeSegment: string): boolean {
    return this.hasPanel(routeSegment);
  }
  ownsAttachmentKind(kind: string): boolean {
    return [...this.entries.values()].some((entry) => entry.pills.has(kind));
  }
  screen(routeSegment: string) {
    return [...this.entries.values()].map((entry) => entry.screens.get(routeSegment)).find(Boolean);
  }
}
