import { router, usePathname } from "expo-router";
import { useCallback } from "react";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { usePanelStore } from "@/stores/panel-store";
import { useMemo } from "react";
import { useSessionStore } from "@/stores/session-store";
import { useHosts } from "@/runtime/host-runtime";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useIsCompactFormFactor } from "@/constants/layout";
import { hostSupportsCapability } from "@/utils/server-info-capabilities";
import { mobileNavTileTestID } from "@/components/sidebar/nav-test-ids";
import type { AppNavItem } from "@/components/sidebar/use-app-nav";
import { builtinClientRegistry } from "./loaded";
import type {
  BuiltinAttachmentPillProps,
  BuiltinClientProps,
  BuiltinScreen as ScreenProps,
} from "./host";
import { BuiltinPluginScreenBoundary } from "./route-boundary";

export function useBuiltinClientContributions(serverId: string) {
  const info = useSessionStore((state) => state.sessions[serverId]?.serverInfo);
  return useMemo(() => builtinClientRegistry.visible(info), [info]);
}
const DEFAULT_SLOT = "default";
export function useBuiltinDestinations(pathname: string, slot = DEFAULT_SLOT): AppNavItem[] {
  const hosts = useHosts();
  const selection = useActiveWorkspaceSelection();
  const match = /^\/h\/([^/]+)/.exec(pathname)?.[1];
  const serverId = match
    ? decodeURIComponent(match)
    : (selection?.serverId ?? hosts[0]?.serverId ?? "");
  const entries = useBuiltinClientContributions(serverId);
  const info = useSessionStore((state) => state.sessions[serverId]?.serverInfo);
  const compact = useIsCompactFormFactor();
  return useMemo(
    () =>
      !serverId
        ? []
        : [...entries.values()].flatMap((entry) =>
            (compact ? entry.mobileEntries : entry.destinations)
              .filter(
                (destination) =>
                  (destination.slot ?? DEFAULT_SLOT) === slot &&
                  (!destination.hostCapabilities ||
                    hostSupportsCapability(info, destination.hostCapabilities)),
              )
              .map((destination) => ({
                key: destination.id,
                group: destination.group,
                label: destination.title,
                shortLabel: destination.shortTitle ?? destination.title,
                icon: destination.icon,
                route: destination.route(serverId),
                isActive: pathname.includes(`/${destination.routeSegment}`),
                testID: `rail-${destination.id}`,
              })),
          ),
    [compact, entries, info, pathname, serverId, slot],
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
      testID={mobileNavTileTestID(item.key, `sidebar-${item.key}-nav`)}
      variant="compact"
    />
  );
}
export function BuiltinSidebarDestinations({ slot }: { slot?: string }) {
  const pathname = usePathname();
  const items = useBuiltinDestinations(pathname, slot);
  return (
    <>
      {items.map((item) => (
        <BuiltinSidebarDestination key={item.key} item={item} />
      ))}
    </>
  );
}

/** Every feature's headless per-host mounts; rendered once in the host route layout. */
export function BuiltinHostMounts({ serverId }: BuiltinClientProps) {
  const entries = useBuiltinClientContributions(serverId);
  return (
    <>
      {[...entries].flatMap(([id, entry]) =>
        [...entry.mounts].map(([key, Mount]) => <Mount key={`${id}/${key}`} serverId={serverId} />),
      )}
    </>
  );
}
export function BuiltinAttachmentPill({
  serverId,
  ...props
}: BuiltinAttachmentPillProps & BuiltinClientProps) {
  const entries = useBuiltinClientContributions(serverId);
  const Pill = [...entries.values()]
    .map((entry) => entry.pills.get(props.attachment.kind))
    .find(Boolean);
  return Pill ? <Pill {...props} /> : null;
}
