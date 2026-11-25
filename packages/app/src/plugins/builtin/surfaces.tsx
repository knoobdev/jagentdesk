import { router, usePathname } from "expo-router";
import { useCallback } from "react";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { usePanelStore } from "@/stores/panel-store";
import { useMemo, useSyncExternalStore } from "react";
import { useSessionStore } from "@/stores/session-store";
import { useHosts } from "@/runtime/host-runtime";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { AppNavItem } from "@/components/sidebar/use-app-nav";
import { builtinClientRegistry } from "./loaded";
import type { BuiltinClientProps, BuiltinDestination, BuiltinScreen as ScreenProps } from "./host";
import { BuiltinPluginScreenBoundary } from "./route-boundary";

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
  const destinations = useMemo(
    () =>
      [...entries.values()]
        .flatMap((entry) => (compact ? entry.mobileEntries : entry.destinations))
        .filter(
          ({ requiresFeature }) =>
            !requiresFeature ||
            (features as Record<string, unknown> | undefined)?.[requiresFeature] === true,
        ),
    [compact, entries, features],
  );
  const routes = useDestinationRoutes(destinations, serverId);
  return useMemo(
    () =>
      !serverId
        ? []
        : destinations.map((destination, index) => ({
            key: destination.id,
            group: destination.group,
            label: destination.title,
            shortLabel: destination.shortTitle ?? destination.title,
            icon: destination.icon,
            route: routes[index] ?? destination.route(serverId),
            isActive: pathname.includes(`/${destination.routeSegment}`),
            testID: `rail-${destination.id}`,
          })),
    [destinations, pathname, routes, serverId],
  );
}
/** Destination routes, re-read when a destination reports that its route changed. */
function useDestinationRoutes(
  destinations: readonly BuiltinDestination[],
  serverId: string,
): readonly string[] {
  const subscribe = useCallback(
    (listener: () => void) => {
      const unsubscribes = destinations.flatMap((destination) =>
        destination.routeChanges ? [destination.routeChanges(listener)] : [],
      );
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
    [destinations],
  );
  const snapshot = useCallback(
    () =>
      serverId ? destinations.map((destination) => destination.route(serverId)).join("\n") : "",
    [destinations, serverId],
  );
  const joined = useSyncExternalStore(subscribe, snapshot, snapshot);
  return useMemo(() => (joined ? joined.split("\n") : []), [joined]);
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
}: BuiltinClientProps & { kind: "settings" | "providerSettings" | "composer" }) {
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
/** Classic sidebar rows; `only`/`except` keep each destination at its established position. */
export function BuiltinSidebarDestinations({
  only,
  except,
}: {
  only?: readonly string[];
  except?: readonly string[];
}) {
  const pathname = usePathname();
  const items = useBuiltinDestinations(pathname);
  return (
    <>
      {(only
        ? only.flatMap((key) => items.filter((item) => item.key === key))
        : items.filter((item) => !except?.includes(item.key))
      ).map((item) => (
        <BuiltinSidebarDestination key={item.key} item={item} />
      ))}
    </>
  );
}
/** Per-host mounts of every enabled plugin (delegation prompts, binders). */
export function BuiltinHostMounts({ serverId }: BuiltinClientProps) {
  const entries = useBuiltinClientContributions(serverId);
  return (
    <>
      {[...entries].flatMap(([id, entry]) =>
        [...entry.mounts].map(([key, Component]) => (
          <Component key={`${id}/${key}`} serverId={serverId} />
        )),
      )}
    </>
  );
}
