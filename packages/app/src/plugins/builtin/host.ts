import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react-native";
import type { BuiltinPluginId } from "@jagentdesk/protocol/builtin-plugins";
import type { PluginAttachmentSourceContribution, PluginTimelineItem } from "@jagentdesk/plugin";
import type { DaemonServerInfo } from "@/stores/session-store";
import { builtinPluginEnabled } from "./registry";

export interface BuiltinClientProps {
  serverId: string;
}
export interface BuiltinDestination {
  id: string;
  title: string;
  icon: LucideIcon;
  group: "Tools" | "main";
  route: (serverId: string) => string;
  routeSegment: string;
  /** Rail position: insert before this core item key instead of after Marketplace. */
  before?: string;
}
export interface BuiltinAgentProps extends BuiltinClientProps {
  agentId: string;
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
}
export interface BuiltinClientHost {
  readonly id: BuiltinPluginId;
  sidebarDestination(destination: BuiltinDestination): void;
  leftPanel(routeSegment: string, component: ComponentType<BuiltinClientProps>): void;
  screen(routeSegment: string, component: ComponentType<BuiltinScreen>): void;
  settingsSection(id: string, component: ComponentType<BuiltinClientProps>): void;
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
  /** Renders nothing visible; mounted for each host route (sync binders, delegation prompts). */
  hostBinder(id: string, component: ComponentType<BuiltinClientProps>): void;
  /** A control in the agent composer's control row, in plugin order. */
  agentControl(id: string, component: ComponentType<BuiltinAgentProps>): void;
  /** Rendered below an agent's conversation. */
  agentPanelAccessory(id: string, component: ComponentType<BuiltinAgentProps>): void;
  turnPreparer(prepare: BuiltinTurnPreparer): void;
}
export interface BuiltinAttachmentSource {
  source: PluginAttachmentSourceContribution;
  search(client: DaemonClient, input: unknown): Promise<unknown>;
}
export interface BuiltinClientContributions {
  destinations: BuiltinDestination[];
  mobileEntries: BuiltinDestination[];
  panels: Map<string, ComponentType<BuiltinClientProps>>;
  screens: Map<string, ComponentType<BuiltinScreen>>;
  settings: Map<string, ComponentType<BuiltinClientProps>>;
  composer: Map<string, ComponentType<BuiltinClientProps>>;
  timeline: Map<string, ComponentType<BuiltinClientProps & { item: PluginTimelineItem }>>;
  attachments: BuiltinAttachmentSource[];
  binders: Map<string, ComponentType<BuiltinClientProps>>;
  agentControls: Map<string, ComponentType<BuiltinAgentProps>>;
  agentPanel: Map<string, ComponentType<BuiltinAgentProps>>;
  turnPreparers: BuiltinTurnPreparer[];
}
export class BuiltinClientRegistry {
  private readonly entries = new Map<BuiltinPluginId, BuiltinClientContributions>();
  forPlugin(id: BuiltinPluginId): BuiltinClientHost {
    if (this.entries.has(id)) throw new Error(`Duplicate built-in client: ${id}`);
    const entry: BuiltinClientContributions = {
      destinations: [],
      mobileEntries: [],
      panels: new Map(),
      screens: new Map(),
      settings: new Map(),
      composer: new Map(),
      timeline: new Map(),
      attachments: [],
      binders: new Map(),
      agentControls: new Map(),
      agentPanel: new Map(),
      turnPreparers: [],
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
      leftPanel: (key, component) => add(entry.panels, key, component),
      screen: (key, component) => add(entry.screens, key, component),
      settingsSection: (key, component) => add(entry.settings, key, component),
      composerItem: (key, component) => add(entry.composer, key, component),
      timelineRenderer: (key, component) => add(entry.timeline, key, component),
      attachmentSource: (source, search) => entry.attachments.push({ source, search }),
      hostBinder: (key, component) => add(entry.binders, key, component),
      agentControl: (key, component) => add(entry.agentControls, key, component),
      agentPanelAccessory: (key, component) => add(entry.agentPanel, key, component),
      turnPreparer: (prepare) => entry.turnPreparers.push(prepare),
    };
  }
  /** Every consumer selects against live per-host state, including retained screens. */
  visible(
    info: DaemonServerInfo | null | undefined,
  ): ReadonlyMap<BuiltinPluginId, BuiltinClientContributions> {
    return new Map([...this.entries].filter(([id]) => builtinPluginEnabled(info, id)));
  }
  /** Destinations that drill the sidebar into the feature's own left panel. */
  drillInDestinations(): readonly BuiltinDestination[] {
    return [...this.entries.values()].flatMap((entry) =>
      entry.destinations.filter((destination) => entry.panels.has(destination.routeSegment)),
    );
  }
  hasPlugin(id: string): boolean {
    return [...this.entries.keys()].some((pluginId) => pluginId === id);
  }
  owner(routeSegment: string): BuiltinPluginId | undefined {
    return [...this.entries].find(([, entry]) => entry.screens.has(routeSegment))?.[0];
  }
  screen(routeSegment: string) {
    return [...this.entries.values()].map((entry) => entry.screens.get(routeSegment)).find(Boolean);
  }
}
