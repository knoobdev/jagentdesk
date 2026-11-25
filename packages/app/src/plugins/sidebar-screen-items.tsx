import { SidebarFrame } from "./sidebar-kit";
import type {
  PluginHostProps,
  PluginOpenScreenInput,
  PluginPopoverProps,
  PluginSidebarItemContribution,
} from "@jagentdesk/plugin/client";
import { router, useGlobalSearchParams, usePathname } from "expo-router";
import { useCallback, useMemo, useState, type ComponentType } from "react";
import { Platform, ScrollView, Text } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { resolvePluginIcon } from "./icons";
import { useInstalledPlugin, useInstalledPlugins } from "./registry";
import { PluginRuntimeBoundary } from "./runtime-boundary";
import { SurfaceErrorBoundary } from "./surface-error-boundary";
import { Modal } from "./react-native/modal";
import { buildPluginSurfaceRoute, hostIdFromPathname } from "./routes";
import { toPluginTheme } from "./theme";
import type { InstalledPlugin } from "./types";

export function pluginScreenRoute(
  serverId: string,
  pluginId: string,
  input: PluginOpenScreenInput,
) {
  const path = buildPluginSurfaceRoute(serverId, pluginId, { kind: "surface", id: input.screenId });
  const query = new URLSearchParams(
    Object.entries(input.params ?? {}).map(([key, value]) => [`pluginParam.${key}`, value]),
  );
  return query.size ? (`${path}?${query}` as const) : path;
}

export function usePluginScreenSidebarItems(section: "header" | "footer") {
  const plugins = useInstalledPlugins();
  const pathname = usePathname();
  const hostId = hostIdFromPathname(pathname);
  return useMemo(() => {
    const entries = new Map<
      string,
      { plugin: InstalledPlugin; item: PluginSidebarItemContribution }
    >();
    for (const plugin of plugins) {
      const items = section === "header" ? plugin.sidebarHeaderItems : plugin.sidebarFooterItems;
      for (const item of items ?? []) {
        const key = `${plugin.id}/${section}/${item.id}`;
        if (!entries.has(key) || plugin.serverId === hostId) entries.set(key, { plugin, item });
      }
    }
    return [...entries].map(([key, entry]) => ({ key, plugin: entry.plugin, item: entry.item }));
  }, [plugins, section, hostId]);
}

export function openPluginSidebarItem(plugin: InstalledPlugin, itemId: string) {
  router.push(
    buildPluginSurfaceRoute(plugin.serverId, plugin.id, {
      kind: "surface",
      id: plugin.surfaces[0]?.id ?? itemId,
    }),
  );
}

function SidebarEntry({
  plugin,
  item,
  theme,
}: {
  plugin: InstalledPlugin;
  item: PluginSidebarItemContribution;
  theme: PluginHostProps["theme"];
}) {
  const compact = useIsCompactFormFactor();
  const hosts = useHosts();
  const pathname = usePathname();
  const routeParams = useGlobalSearchParams();
  const [Content, setContent] = useState<ComponentType<PluginPopoverProps> | null>(null);
  const [open, setOpen] = useState(false);
  const openScreen = useCallback(
    (input: PluginOpenScreenInput) => {
      if (!plugin.surfaces.some((screen) => screen.id === input.screenId))
        throw new Error(`Plugin screen is unavailable: ${input.screenId}`);
      setOpen(false);
      router.push(pluginScreenRoute(plugin.serverId, plugin.id, input));
    },
    [plugin],
  );
  const openPopover = useCallback((component: ComponentType<PluginPopoverProps>) => {
    setContent(() => component);
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);
  const host = useMemo(
    () => ({
      id: plugin.serverId,
      label: hosts.find((entry) => entry.serverId === plugin.serverId)?.label ?? plugin.serverId,
    }),
    [hosts, plugin.serverId],
  );
  const layout = useMemo(
    () => ({
      compact,
      platform: resolvePlatform(),
    }),
    [compact],
  );
  const screenParams = Object.fromEntries(
    Object.entries(routeParams).flatMap(([key, value]) =>
      key.startsWith("pluginParam.") && typeof value === "string" ? [[key.slice(12), value]] : [],
    ),
  );
  const screenId = plugin.surfaces.find(
    (screen) =>
      pathname ===
      buildPluginSurfaceRoute(plugin.serverId, plugin.id, { kind: "surface", id: screen.id }),
  )?.id;
  const currentScreen = useMemo(
    () => (screenId ? { screenId, params: screenParams } : null),
    [screenId, screenParams],
  );
  const frame = useMemo(
    () => ({ title: item.title, testID: `plugin-sidebar-${plugin.id}-${item.id}` }),
    [plugin.id, item],
  );
  const Component = item.Component;
  return (
    <SidebarFrame.Provider value={frame}>
      <Component
        theme={theme}
        host={host}
        layout={layout}
        currentScreen={currentScreen}
        openScreen={openScreen}
        openPopover={openPopover}
      />
      <Modal title={item.title} open={open} onOpenChange={setOpen}>
        <Modal.Content>
          {Content ? (
            <Content
              theme={theme}
              host={host}
              layout={layout}
              close={close}
              openScreen={openScreen}
            />
          ) : null}
        </Modal.Content>
      </Modal>
    </SidebarFrame.Provider>
  );
}
const ThemedSidebarEntry = withUnistyles(SidebarEntry);
const themeMapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });

export function PluginSidebarPanel({ serverId, pluginId }: { serverId: string; pluginId: string }) {
  const plugin = useInstalledPlugin(serverId, pluginId);
  const client = useHostRuntimeClient(serverId);
  if (!plugin || !client) return <Text style={styles.message}>Plugin host is offline.</Text>;
  const items = [...(plugin.sidebarHeaderItems ?? []), ...(plugin.sidebarFooterItems ?? [])];
  return (
    <ScrollView testID={`plugin-left-panel-${pluginId}`} contentContainerStyle={styles.panel}>
      <Text style={styles.title}>{pluginId}</Text>
      {items.map((item) => (
        <SurfaceErrorBoundary key={item.id} installation={plugin} Surface={item.Component}>
          <PluginRuntimeBoundary plugin={plugin} client={client}>
            <ThemedSidebarEntry plugin={plugin} item={item} uniProps={themeMapping} />
          </PluginRuntimeBoundary>
        </SurfaceErrorBoundary>
      ))}
      {plugin.sidebarItems.map((item) => (
        <LegacyPanelRow key={item.id} plugin={plugin} item={item} />
      ))}
    </ScrollView>
  );
}
const styles = StyleSheet.create((theme) => ({
  panel: { paddingVertical: theme.spacing[3], gap: theme.spacing[1] },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[3],
  },
  message: { color: theme.colors.foregroundMuted, padding: theme.spacing[3] },
  row: { flexDirection: "row", alignItems: "center" },
  rowBody: { flex: 1 },
  separator: { height: 1, backgroundColor: theme.colors.border, marginVertical: theme.spacing[2] },
}));

function resolvePlatform(): "ios" | "android" | "web" {
  if (Platform.OS === "ios") return "ios";
  if (Platform.OS === "android") return "android";
  return "web";
}
function LegacyPanelRow({
  plugin,
  item,
}: {
  plugin: InstalledPlugin;
  item: InstalledPlugin["sidebarItems"][number];
}) {
  const onPress = useCallback(
    () =>
      router.push(
        buildPluginSurfaceRoute(plugin.serverId, plugin.id, { kind: "sidebar", id: item.id }),
      ),
    [plugin, item.id],
  );
  return (
    <SidebarHeaderRow
      icon={resolvePluginIcon(item.icon)}
      label={item.title}
      variant="compact"
      onPress={onPress}
    />
  );
}
