import type { PluginSidebarViewContribution } from "@jagentdesk/plugin/client";
import { PluginTranslationRuntime, type PluginLocaleSource } from "@jagentdesk/plugin/client/host";
import * as pluginClientRuntime from "@jagentdesk/plugin/client";
import {
  type PluginText,
  type PluginCommandCenterItemContribution,
  type PluginClientContext,
  type PluginScreenContribution,
  type PluginScreenProps,
  type PluginSidebarItemContribution,
  type PluginClientSlashCommandContribution,
  type PluginSidebarContribution,
  type PluginSurfaceProps,
  type PluginTimelineRendererContribution,
  type PluginTimelineTransformerContribution,
  type PluginWorkspacePanelContribution,
  type PluginButtonRegistration,
} from "@jagentdesk/plugin/client";
import { localizePluginContribution, registerTranslatedButton } from "./translations";
import { type createPluginHosts } from "./hosts";
import { openExternalUrl } from "@/utils/open-external-url";
import * as pluginUiRuntime from "./react-native/ui";
import { useSettings } from "./settings/use-settings";
import * as pluginSharedRuntime from "@jagentdesk/plugin";
import {
  type PluginAttachmentSourceContribution,
  type PluginCleanup,
  type PluginThemeContribution,
} from "@jagentdesk/plugin";
import * as React from "react";
import { type ComponentType } from "react";
import * as ReactJsxRuntime from "react/jsx-runtime";
import * as ReactNative from "react-native";
// Plugin bundles receive TanStack hooks as part of their public SDK.
// oxlint-disable-next-line no-restricted-imports
import * as ReactQuery from "@tanstack/react-query";
import * as Zod from "zod";
import { type EvaluatedPlugin } from "./types";
import { resolvePluginIcon, parsePluginIcon, parseSerializablePluginIcon } from "./icons";
import { pluginReactNativeRuntime } from "./react-native/runtime";
import { parsePluginThemeContribution } from "./themes";

// eslint-disable-next-line no-restricted-imports -- plugin client runtime injects host ReactNative.

// eslint-disable-next-line no-restricted-imports -- plugin bundles receive TanStack's real runtime, not JAgentDesk's query wrappers.

const CONTRIBUTION_ID = /^[a-z][a-z0-9-]*$/;

const PANEL_LOCATIONS = ["workspace", "explorer"] as const;

const TIMELINE_ITEM_TYPES = new Set([
  "user_message",
  "assistant_message",
  "reasoning",
  "tool_call",
  "todo",
  "notification",
  "error",
  "compaction",
]);

function normalizePanelLocations(
  panelId: string,
  locations: PluginWorkspacePanelContribution["locations"],
): readonly (typeof PANEL_LOCATIONS)[number][] {
  if (locations === undefined) return ["workspace"];
  if (!Array.isArray(locations) || locations.length === 0) {
    throw new Error(`Workspace panel ${panelId} must support at least one location`);
  }
  const normalized = locations.map((location) => {
    if (!PANEL_LOCATIONS.includes(location as never)) {
      throw new Error(`Workspace panel ${panelId} has invalid location: ${String(location)}`);
    }
    return location;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`Workspace panel ${panelId} has duplicate locations`);
  }
  return normalized;
}

function isComponentType(value: unknown): boolean {
  return (
    typeof value === "function" ||
    (typeof value === "object" && value !== null && "$$typeof" in value)
  );
}

function requireId(value: string, label: string): string {
  const id = value.trim();
  if (!CONTRIBUTION_ID.test(id)) throw new Error(`Invalid ${label}: ${value}`);
  return id;
}

export type PluginClientRuntime = Pick<
  PluginClientContext,
  | "playAudio"
  | "jagentdesk"
  | "rpc"
  | "openSettings"
  | "openScreen"
  | "openSurface"
  | "composers"
  | "openPanel"
  | "subscribe"
> & {
  hosts: ReturnType<typeof createPluginHosts>;
  localeSource?: PluginLocaleSource;
  addComposerPill(
    contribution: import("@jagentdesk/plugin/client").PluginComposerPillContribution,
  ): PluginButtonRegistration;
  addHeaderButton(
    contribution: import("@jagentdesk/plugin/client").PluginHeaderButtonContribution,
  ): PluginButtonRegistration;
};

export function runPluginClientBundle(
  id: string,
  bundle: string,
  runtime: PluginClientRuntime,
  onChange: () => void = () => undefined,
): EvaluatedPlugin {
  const translations = new PluginTranslationRuntime(
    runtime.localeSource ?? { getLocale: () => "en", subscribe: () => () => {} },
  );
  const localize = <T extends object>(input: T) => localizePluginContribution(input, translations);
  const sidebarViews: PluginSidebarViewContribution[] = [];
  const sidebarViewIds = new Set<string>();
  const collector: Omit<EvaluatedPlugin, "id" | "cleanup"> = {
    workspaceRowBadgeItems: [],
    surfaces: [],
    settingsScreens: [],
    sidebarViews,
    sidebarItems: [],
    sidebarHeaderItems: [],
    sidebarFooterItems: [],
    composerItems: [],
    newWorkspaceItems: [],
    workspacePanels: [],
    filePanels: [],
    commandCenterItems: [],
    clientSlashCommands: [],
    attachmentSources: [],
    themes: [],
    timelineTransformers: [],
    timelineRenderers: [],
  };
  const surfaceIds = new Set<string>();
  const settingsScreenIds = new Set<string>();
  const sidebarItemIds = new Set<string>();
  const composerItemIds = new Set<string>();
  const newWorkspaceItemIds = new Set<string>();
  const workspacePanelIds = new Set<string>();
  const commandCenterItemIds = new Set<string>();
  const clientSlashCommandNames = new Set<string>();
  const attachmentSourceIds = new Set<string>();
  const themeIds = new Set<string>();
  const timelineTransformerIds = new Set<string>();
  const timelineRendererIds = new Set<string>();
  const removals = new Set<PluginCleanup>();
  removals.add(() => translations.dispose());
  removals.add(translations.subscribe(onChange));
  let setupComplete = false;
  let stopped = false;
  function trackButton(
    registration: PluginButtonRegistration<PluginText>,
  ): PluginButtonRegistration<PluginText> {
    let active = true;
    const remove = () => {
      if (!active) return;
      active = false;
      registration.remove();
      removals.delete(remove);
    };
    removals.add(remove);
    return {
      update: (patch) => {
        if (active && !stopped) registration.update(patch);
      },
      remove,
    };
  }
  const notifyChange = () => {
    if (setupComplete) onChange();
  };
  function register<T>(items: T[], item: T, release: () => void, origin?: object): PluginCleanup {
    const registered = localizePluginContribution(item as object, translations, origin) as T;
    items.push(registered);
    notifyChange();
    let active = true;
    const remove = () => {
      if (!active) return;
      active = false;
      const index = items.indexOf(registered);
      if (index !== -1) items.splice(index, 1);
      release();
      removals.delete(remove);
      notifyChange();
    };
    removals.add(remove);
    return remove;
  }
  function addSidebarEntry(
    section: "header" | "footer",
    input: PluginSidebarItemContribution<PluginText>,
  ) {
    const contribution = localize(input);
    const normalizedId = requireId(contribution.id, `sidebar ${section} item id`);
    const entries =
      section === "header" ? collector.sidebarHeaderItems! : collector.sidebarFooterItems!;
    if (entries.some((entry) => entry.id === normalizedId))
      throw new Error(`Duplicate sidebar ${section} item: ${normalizedId}`);
    const title = contribution.title.trim();
    if (!title) throw new Error(`Sidebar item ${normalizedId} has no title`);
    if (!isComponentType(contribution.Component))
      throw new Error(`Sidebar item ${normalizedId} is not a component`);
    return register(entries, { ...contribution, id: normalizedId, title }, () => {}, contribution);
  }
  const pluginContext: PluginClientContext = {
    ...runtime,
    i18n: translations,
    addScreen(input: PluginScreenContribution<PluginText>) {
      const contribution = localize(input);
      const normalizedId = requireId(contribution.id, "screen id");
      if (surfaceIds.has(normalizedId)) throw new Error(`Duplicate screen: ${normalizedId}`);
      if (
        !(
          typeof contribution.title === "function" ||
          (typeof contribution.title === "string" && contribution.title.trim())
        )
      )
        throw new Error(`Screen ${normalizedId} needs a title`);
      if (!isComponentType(contribution.Component))
        throw new Error(`Screen ${normalizedId} is not a component`);
      surfaceIds.add(normalizedId);
      return register(
        collector.surfaces,
        { ...contribution, id: normalizedId },
        () => surfaceIds.delete(normalizedId),
        contribution,
      );
    },
    addComposerItem(contribution) {
      const normalizedId = requireId(contribution.id, "composer item id");
      if (composerItemIds.has(normalizedId))
        throw new Error(`Duplicate composer item: ${normalizedId}`);
      if (!isComponentType(contribution.Component)) {
        throw new Error(`Composer item ${normalizedId} is not a component`);
      }
      composerItemIds.add(normalizedId);
      return register(
        collector.composerItems,
        { id: normalizedId, Component: contribution.Component },
        () => composerItemIds.delete(normalizedId),
      );
    },
    addNewWorkspaceItem(contribution) {
      const normalizedId = requireId(contribution.id, "New workspace item id");
      if (newWorkspaceItemIds.has(normalizedId))
        throw new Error(`Duplicate New workspace item: ${normalizedId}`);
      if (!isComponentType(contribution.Component)) {
        throw new Error(`New workspace item ${normalizedId} is not a component`);
      }
      newWorkspaceItemIds.add(normalizedId);
      return register(
        collector.newWorkspaceItems,
        { id: normalizedId, Component: contribution.Component },
        () => newWorkspaceItemIds.delete(normalizedId),
      );
    },
    addSidebarHeaderItem(contribution) {
      return addSidebarEntry("header", contribution);
    },
    addSidebarFooterItem(contribution) {
      return addSidebarEntry("footer", contribution);
    },
    addSettingsScreen(input) {
      const contribution = localize(input);
      const screenId = requireId(contribution.id, "settings screen id");
      if (settingsScreenIds.has(screenId))
        throw new Error(`Duplicate settings screen: ${screenId}`);
      if (!contribution.title.trim()) throw new Error(`Invalid settings screen: ${screenId}`);
      resolvePluginIcon(contribution.icon);
      settingsScreenIds.add(screenId);
      return register(
        collector.settingsScreens,
        { ...contribution, id: screenId },
        () => settingsScreenIds.delete(screenId),
        contribution,
      );
    },
    addSurface(surfaceId: string, Component: ComponentType<PluginSurfaceProps>) {
      const normalizedId = requireId(surfaceId, "surface id");
      if (surfaceIds.has(normalizedId)) throw new Error(`Duplicate surface: ${normalizedId}`);
      if (typeof Component !== "function")
        throw new Error(`Surface ${normalizedId} is not a component`);
      surfaceIds.add(normalizedId);
      return register(
        collector.surfaces,
        {
          id: normalizedId,
          Component: Component as ComponentType<PluginScreenProps>,
        },
        () => surfaceIds.delete(normalizedId),
      );
    },
    addSidebarView(input) {
      const contribution = localize(input);
      const normalizedId = requireId(contribution.id, "sidebar view id");
      if (sidebarViewIds.has(normalizedId))
        throw new Error(`Duplicate sidebar view: ${normalizedId}`);
      if (typeof contribution.Component !== "function")
        throw new Error(`Sidebar view ${normalizedId} is not a component`);
      if (!contribution.title.trim()) throw new Error(`Sidebar view ${normalizedId} has no title`);
      sidebarViewIds.add(normalizedId);
      return register(
        sidebarViews,
        { ...contribution, id: normalizedId },
        () => sidebarViewIds.delete(normalizedId),
        contribution,
      );
    },
    addSidebarItem(input: PluginSidebarContribution<PluginText>) {
      const contribution = localize(input);
      const normalizedId = requireId(contribution.id, "sidebar item id");
      if (sidebarItemIds.has(normalizedId))
        throw new Error(`Duplicate sidebar item: ${normalizedId}`);
      if (!contribution.title.trim()) throw new Error(`Sidebar item ${normalizedId} has no title`);
      const icon = parsePluginIcon(`Sidebar item ${normalizedId}`, contribution.icon);
      sidebarItemIds.add(normalizedId);
      return register(
        collector.sidebarItems,
        {
          ...contribution,
          id: normalizedId,
          title: contribution.title.trim(),
          icon,
          surface: requireId(contribution.surface, "sidebar surface id"),
        },
        () => sidebarItemIds.delete(normalizedId),
        contribution,
      );
    },
    addFilePanel(input) {
      const contribution = localize(input);
      const panelId = requireId(contribution.id, "file panel id");
      if (collector.filePanels!.some((panel) => panel.id === panelId))
        throw new Error(`Duplicate file panel: ${panelId}`);
      if (!contribution.title.trim()) throw new Error(`File panel ${panelId} has no title`);
      resolvePluginIcon(contribution.icon);
      if (!contribution.files || !Array.isArray(contribution.files.extensions))
        throw new Error(`File panel ${panelId} has no file selector`);
      if (!isComponentType(contribution.Component))
        throw new Error(`File panel ${panelId} is not a component`);
      return register(
        collector.filePanels!,
        { ...contribution, id: panelId },
        () => {},
        contribution,
      );
    },
    addWorkspaceRowBadgeItem(input) {
      const contribution = localize(input);
      const normalizedId = requireId(contribution.id, "workspace row badge item id");
      if (collector.workspaceRowBadgeItems!.some((item) => item.id === normalizedId))
        throw new Error(`Duplicate workspace row badge item: ${normalizedId}`);
      if (!contribution.title.trim())
        throw new Error(`Workspace row badge item ${normalizedId} has no title`);
      parsePluginIcon(`Workspace row badge item ${normalizedId}`, contribution.icon);
      if (!isComponentType(contribution.Component))
        throw new Error(`Workspace row badge item ${normalizedId} is not a component`);
      return register(
        collector.workspaceRowBadgeItems!,
        { ...contribution, id: normalizedId },
        () => {},
        contribution,
      );
    },
    addAgentPanel(contribution) {
      return pluginContext.addWorkspacePanel({ ...contribution, context: "agent" });
    },
    addWorkspacePanel(input: PluginWorkspacePanelContribution<PluginText>) {
      const contribution = localize({
        ...input,
        context: input.context ?? "workspace",
      }) as PluginWorkspacePanelContribution;
      const normalizedId = requireId(contribution.id, "workspace panel id");
      if (workspacePanelIds.has(normalizedId)) {
        throw new Error(`Duplicate workspace panel: ${normalizedId}`);
      }
      const title = contribution.title.trim();
      const icon = parsePluginIcon(`Plugin contribution ${normalizedId}`, contribution.icon);
      if (!title) throw new Error(`Workspace panel ${normalizedId} has no title`);
      if (!icon) throw new Error(`Workspace panel ${normalizedId} has no icon`);
      if (contribution.context !== "workspace" && contribution.context !== "agent") {
        throw new Error(`Workspace panel ${normalizedId} has invalid context`);
      }
      if (typeof contribution.Component !== "function") {
        throw new Error(`Workspace panel ${normalizedId} is not a component`);
      }
      resolvePluginIcon(icon);
      const locations = normalizePanelLocations(normalizedId, contribution.locations);
      workspacePanelIds.add(normalizedId);
      return register(
        collector.workspacePanels,
        {
          ...contribution,
          id: normalizedId,
          title,
          icon,
          locations,
        },
        () => workspacePanelIds.delete(normalizedId),
        contribution,
      );
    },
    addCommandCenterItem(input: PluginCommandCenterItemContribution<PluginText>) {
      const contribution = localize(input);
      const normalizedId = requireId(contribution.id, "Command Center item id");
      if (commandCenterItemIds.has(normalizedId)) {
        throw new Error(`Duplicate Command Center item: ${normalizedId}`);
      }
      const title = contribution.title.trim();
      const icon = parsePluginIcon(`Plugin contribution ${normalizedId}`, contribution.icon);
      if (!title) throw new Error(`Command Center item ${normalizedId} has no title`);
      if (!icon) throw new Error(`Command Center item ${normalizedId} has no icon`);
      if (
        contribution.context !== "global" &&
        contribution.context !== "workspace" &&
        contribution.context !== "agent"
      ) {
        throw new Error(`Command Center item ${normalizedId} has invalid context`);
      }
      if (typeof contribution.onSelect !== "function") {
        throw new Error(`Command Center item ${normalizedId} has no callback`);
      }
      resolvePluginIcon(icon);
      commandCenterItemIds.add(normalizedId);
      return register(
        collector.commandCenterItems,
        {
          ...contribution,
          id: normalizedId,
          title,
          icon,
          keywords: contribution.keywords?.map((keyword) => keyword.trim()).filter(Boolean),
        },
        () => commandCenterItemIds.delete(normalizedId),
        contribution,
      );
    },
    addSlashCommand(input: PluginClientSlashCommandContribution<PluginText>) {
      const contribution = localize(input);
      const name = requireId(contribution.name, "client slash command name");
      if (clientSlashCommandNames.has(name)) {
        throw new Error(`Duplicate client slash command: ${name}`);
      }
      const description = contribution.description.trim();
      if (!description) throw new Error(`Client slash command ${name} has no description`);
      if (contribution.context !== "workspace" && contribution.context !== "agent") {
        throw new Error(`Client slash command ${name} has invalid context`);
      }
      if (typeof contribution.onSubmit !== "function") {
        throw new Error(`Client slash command ${name} has no callback`);
      }
      clientSlashCommandNames.add(name);
      return register(
        collector.clientSlashCommands,
        {
          ...contribution,
          name,
          description,
          argumentHint: contribution.argumentHint.trim(),
        },
        () => clientSlashCommandNames.delete(name),
        contribution,
      );
    },
    addAttachmentSource(input: PluginAttachmentSourceContribution<PluginText>) {
      const contribution = localize(input);
      const normalizedId = requireId(contribution.id, "attachment source id");
      if (attachmentSourceIds.has(normalizedId)) {
        throw new Error(`Duplicate attachment source: ${normalizedId}`);
      }
      const title = contribution.title.trim();
      const icon = parseSerializablePluginIcon(
        `Attachment source ${normalizedId}`,
        contribution.icon,
      );
      const pickerTitle = contribution.pickerTitle.trim();
      const searchPlaceholder = contribution.searchPlaceholder.trim();
      const method = contribution.search.name.trim();
      if (!title) throw new Error(`Attachment source ${normalizedId} has no title`);
      if (!icon) throw new Error(`Attachment source ${normalizedId} has no icon`);
      if (!pickerTitle) throw new Error(`Attachment source ${normalizedId} has no picker title`);
      if (!searchPlaceholder) {
        throw new Error(`Attachment source ${normalizedId} has no search placeholder`);
      }
      if (!method) throw new Error(`Attachment source ${normalizedId} has no search RPC`);
      resolvePluginIcon(icon);
      attachmentSourceIds.add(normalizedId);
      return register(
        collector.attachmentSources,
        {
          ...contribution,
          id: normalizedId,
          title,
          icon,
          pickerTitle,
          searchPlaceholder,
          search: { ...contribution.search, name: method },
        },
        () => attachmentSourceIds.delete(normalizedId),
        contribution,
      );
    },
    addTheme(input: PluginThemeContribution<PluginText>) {
      const contribution = localize(input);
      const normalizedId = requireId(contribution.id, "theme id");
      if (themeIds.has(normalizedId)) throw new Error(`Duplicate theme: ${normalizedId}`);
      const theme = parsePluginThemeContribution({ ...contribution, id: normalizedId });
      themeIds.add(normalizedId);
      return register(
        collector.themes,
        { ...contribution, ...theme },
        () => themeIds.delete(normalizedId),
        contribution,
      );
    },
    addTimelineTransformer(contribution: PluginTimelineTransformerContribution) {
      const normalizedId = requireId(contribution.id, "timeline transformer id");
      if (timelineTransformerIds.has(normalizedId)) {
        throw new Error(`Duplicate timeline transformer: ${normalizedId}`);
      }
      if (!contribution.query || typeof contribution.query.itemType !== "string") {
        throw new Error(`Timeline transformer ${normalizedId} has no item type`);
      }
      if (!TIMELINE_ITEM_TYPES.has(contribution.query.itemType)) {
        throw new Error(
          `Timeline transformer ${normalizedId} has invalid item type: ${contribution.query.itemType}`,
        );
      }
      if (typeof contribution.transform !== "function") {
        throw new Error(`Timeline transformer ${normalizedId} has no transform`);
      }
      if (contribution.id !== normalizedId) {
        throw new Error(`Invalid timeline transformer id: ${contribution.id}`);
      }
      timelineTransformerIds.add(normalizedId);
      return register(collector.timelineTransformers, contribution, () =>
        timelineTransformerIds.delete(normalizedId),
      );
    },
    addTimelineRenderer(contribution: PluginTimelineRendererContribution) {
      const kind = requireId(contribution.kind, "timeline renderer kind");
      if (!Number.isInteger(contribution.version) || contribution.version < 1) {
        throw new Error(`Timeline renderer ${kind} has invalid version`);
      }
      const rendererId = `${kind}/${contribution.version}`;
      if (timelineRendererIds.has(rendererId)) {
        throw new Error(`Duplicate timeline renderer: ${rendererId}`);
      }
      if (!contribution.schema || typeof contribution.schema.safeParse !== "function") {
        throw new Error(`Timeline renderer ${rendererId} has no schema`);
      }
      if (typeof contribution.Component !== "function") {
        throw new Error(`Timeline renderer ${rendererId} is not a component`);
      }
      timelineRendererIds.add(rendererId);
      return register(collector.timelineRenderers, { ...contribution, kind }, () =>
        timelineRendererIds.delete(rendererId),
      );
    },
    addComposerPill(contribution) {
      if (stopped) throw new Error("Plugin has stopped");
      return trackButton(
        registerTranslatedButton(contribution.button, translations, (button) =>
          runtime.addComposerPill({ ...contribution, button }),
        ),
      );
    },
    addHeaderButton(contribution) {
      if (stopped) throw new Error("Plugin has stopped");
      return trackButton(
        registerTranslatedButton(contribution.button, translations, (button) =>
          runtime.addHeaderButton({ ...contribution, button }),
        ),
      );
    },
  };
  const runtimeRequire = (name: string): unknown => {
    if (name === "@jagentdesk/plugin/client/ui") return pluginUiRuntime;
    if (name === "react") return React;
    if (name === "react/jsx-runtime") return ReactJsxRuntime;
    if (name === "react-native") return ReactNative;
    if (name === "@jagentdesk/plugin") return pluginSharedRuntime;
    if (name === "@jagentdesk/plugin/client")
      return {
        ...pluginClientRuntime,
        useSettings: (definition: import("@jagentdesk/plugin").SettingsDefinition) =>
          useSettings(definition, id),
        openExternalUrl,
        getJAgentDeskClient: (serverId: string) => runtime.hosts.getJAgentDeskClient(serverId),
        useHosts: () =>
          React.useSyncExternalStore(
            runtime.hosts.subscribe,
            runtime.hosts.getSnapshot,
            runtime.hosts.getSnapshot,
          ),
      };
    if (name === "@jagentdesk/plugin/client/react-native") {
      return pluginReactNativeRuntime;
    }
    if (name === "@tanstack/react-query") return ReactQuery;
    if (name === "zod") return Zod;
    throw new Error(`Module "${name}" is not available in plugin client code`);
  };
  const evaluate: (source: string) => unknown = globalThis.eval;
  const factory = evaluate(bundle);
  if (typeof factory !== "function")
    throw new Error(`Plugin ${id} client bundle is not executable`);
  const exports = factory(runtimeRequire);
  const setup =
    exports !== null && typeof exports === "object" ? Reflect.get(exports, "default") : undefined;
  if (typeof setup !== "function") {
    throw new Error(`Plugin ${id} must default export a function`);
  }
  let entryCleanup: PluginCleanup | undefined;
  try {
    entryCleanup = setup(pluginContext);
    if (typeof entryCleanup !== "function")
      throw new Error(`Plugin ${id} contribution must return a cleanup function`);
    for (const item of collector.sidebarItems) {
      if (!surfaceIds.has(item.surface)) {
        throw new Error(`Sidebar item ${item.id} references missing surface ${item.surface}`);
      }
    }
  } catch (error) {
    stopped = true;
    try {
      void Promise.resolve(
        typeof entryCleanup === "function" ? entryCleanup() : entryCleanup,
      ).catch((cleanupError) => {
        console.warn(`[Plugins] Cleanup failed after setup error for ${id}`, cleanupError);
      });
    } catch (cleanupError) {
      console.warn(`[Plugins] Cleanup failed after setup error for ${id}`, cleanupError);
    } finally {
      for (const remove of removals) remove();
    }
    throw error;
  }
  setupComplete = true;
  const cleanupEntry = entryCleanup;
  const cleanup = async () => {
    if (stopped) return;
    stopped = true;
    try {
      await cleanupEntry();
    } finally {
      for (const remove of removals) remove();
    }
  };
  return {
    id,
    cleanup,
    translations,
    workspaceRowBadgeItems: collector.workspaceRowBadgeItems,
    surfaces: collector.surfaces,
    settingsScreens: collector.settingsScreens,
    sidebarViews,
    sidebarItems: collector.sidebarItems,
    sidebarHeaderItems: collector.sidebarHeaderItems,
    sidebarFooterItems: collector.sidebarFooterItems,
    filePanels: collector.filePanels,
    composerItems: collector.composerItems,
    newWorkspaceItems: collector.newWorkspaceItems,
    workspacePanels: collector.workspacePanels as EvaluatedPlugin["workspacePanels"],
    commandCenterItems: collector.commandCenterItems,
    clientSlashCommands: collector.clientSlashCommands,
    attachmentSources: collector.attachmentSources,
    themes: collector.themes,
    timelineTransformers: collector.timelineTransformers,
    timelineRenderers: collector.timelineRenderers,
  };
}
