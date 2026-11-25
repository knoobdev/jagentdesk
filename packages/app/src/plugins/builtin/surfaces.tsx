import { router, usePathname } from "expo-router";
import { useCallback } from "react";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { usePanelStore } from "@/stores/panel-store";
import { useMemo } from "react";
import { useSessionStore } from "@/stores/session-store";
import { useHosts } from "@/runtime/host-runtime";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { AppNavItem } from "@/components/sidebar/use-app-nav";
import { builtinClientRegistry } from "./loaded";
import type { BuiltinClientProps, BuiltinScreen as ScreenProps } from "./host";
import { BuiltinPluginScreenBoundary } from "./route-boundary";

/** Destinations that keep their historical position in the navigation lists. */
export const SLOTTED_BUILTIN_DESTINATIONS: ReadonlySet<string> = new Set(["servers"]);
export function useBuiltinClientContributions(serverId: string) {
  const info = useSessionStore((state) => state.sessions[serverId]?.serverInfo);
  return useMemo(() => builtinClientRegistry.visible(info), [info]);
}
function useServerFeatures(serverId: string) {
  return useSessionStore((state) => state.sessions[serverId]?.serverInfo?.features);
}
export function useBuiltinDestinations(pathname: string): AppNavItem[] {
  const hosts = useHosts();
  const selection = useActiveWorkspaceSelection();
  const match = /^\/h\/([^/]+)/.exec(pathname)?.[1];
  const serverId = match
    ? decodeURIComponent(match)
    : (selection?.serverId ?? hosts[0]?.serverId ?? "");
  const entries = useBuiltinClientContributions(serverId);
  const features = useServerFeatures(serverId);
  const compact = useIsCompactFormFactor();
  return useMemo(
    () =>
      !serverId
        ? []
        : [...entries.values()].flatMap((entry) =>
            (compact ? entry.mobileEntries : entry.destinations)
              .filter(
                ({ requiresFeature }) =>
                  !requiresFeature ||
                  (features as Record<string, unknown> | undefined)?.[requiresFeature] === true,
              )
              .map((destination) => ({
                key: destination.id,
                group: destination.group,
                label: destination.title,
                shortLabel: destination.title,
                icon: destination.icon,
                route: destination.route(serverId),
                isActive: pathname.includes(`/${destination.routeSegment}`),
                testID: `rail-${destination.id}`,
              })),
          ),
    [compact, entries, features, pathname, serverId],
  );
}
export function BuiltinLeftPanel({ serverId, segment }: BuiltinClientProps & { segment: string }) {
  const entries = useBuiltinClientContributions(serverId);
  const Panel = [...entries.values()].map((entry) => entry.panels.get(segment)).find(Boolean);
  return Panel ? <Panel serverId={serverId} /> : null;
}
export function BuiltinScreen({ serverId, segment, ...props }: ScreenProps & { segment: string }) {
  const id = builtinClientRegistry.owner(segment);
  const Screen = builtinClientRegistry.screen(segment);
  return id && Screen ? (
    <BuiltinPluginScreenBoundary id={id} serverId={serverId}>
      <Screen serverId={serverId} {...props} />
    </BuiltinPluginScreenBoundary>
  ) : null;
}
/** Shared live selectors for the settings, composer, timeline, and attachment adapters. */
export function BuiltinClientItems({
  serverId,
  kind,
}: BuiltinClientProps & { kind: "settings" | "composer" }) {
  const entries = useBuiltinClientContributions(serverId);
  return (
    <>
      {[...entries].flatMap(([id, entry]) =>
        [...entry[kind]].map(([key, Component]) => (
          <Component key={`${id}/${key}`} serverId={serverId} />
        )),
      )}
    </>
  );
}

function BuiltinSidebarDestination({ item }: { item: AppNavItem }) {
  const onPress = useCallback(() => {
    usePanelStore.getState().showMobileAgent();
    if (item.onPress) item.onPress();
    else router.push(item.route);
  }, [item]);
  return (
    <SidebarHeaderRow
      icon={item.icon}
      label={item.label}
      onPress={onPress}
      isActive={item.isActive}
      testID={`sidebar-${item.key}-nav`}
      variant="compact"
    />
  );
}
/** `only` renders slotted destinations at their position; the default renders the rest. */
export function BuiltinSidebarDestinations({ only }: { only?: readonly string[] }) {
  const pathname = usePathname();
  const all = useBuiltinDestinations(pathname);
  const items = only
    ? all.filter((item) => only.includes(item.key))
    : all.filter((item) => !SLOTTED_BUILTIN_DESTINATIONS.has(item.key));
  return (
    <>
      {items.map((item) => (
        <BuiltinSidebarDestination key={item.key} item={item} />
      ))}
    </>
  );
}
