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
import type {
  BuiltinAgentProps,
  BuiltinClientProps,
  BuiltinScreen as ScreenProps,
  BuiltinTurnPreparation,
} from "./host";
import { BuiltinPluginScreenBoundary } from "./route-boundary";

export function useBuiltinClientContributions(serverId: string) {
  const info = useSessionStore((state) => state.sessions[serverId]?.serverInfo);
  return useMemo(() => builtinClientRegistry.visible(info), [info]);
}
export function useBuiltinDestinations(pathname: string): AppNavItem[] {
  const hosts = useHosts();
  const selection = useActiveWorkspaceSelection();
  const match = /^\/h\/([^/]+)/.exec(pathname)?.[1];
  const serverId = match
    ? decodeURIComponent(match)
    : (selection?.serverId ?? hosts[0]?.serverId ?? "");
  const entries = useBuiltinClientContributions(serverId);
  const compact = useIsCompactFormFactor();
  return useMemo(
    () =>
      !serverId
        ? []
        : [...entries.values()].flatMap((entry) =>
            (compact ? entry.mobileEntries : entry.destinations).map((destination) => ({
              key: destination.id,
              group: destination.group,
              label: destination.title,
              shortLabel: destination.title,
              icon: destination.icon,
              route: destination.route(serverId),
              isActive: pathname.includes(`/${destination.routeSegment}`),
              testID: `rail-${destination.id}`,
              before: destination.before,
            })),
          ),
    [compact, entries, pathname, serverId],
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
/** Per-host binders render nothing visible; they mount with the host route. */
export function BuiltinHostBinders({ serverId }: BuiltinClientProps) {
  const entries = useBuiltinClientContributions(serverId);
  return (
    <>
      {[...entries].flatMap(([id, entry]) =>
        [...entry.binders].map(([key, Binder]) => (
          <Binder key={`${id}/${key}`} serverId={serverId} />
        )),
      )}
    </>
  );
}
export function BuiltinAgentItems({
  serverId,
  agentId,
  kind,
}: BuiltinAgentProps & { kind: "agentControls" | "agentPanel" }) {
  const entries = useBuiltinClientContributions(serverId);
  return (
    <>
      {[...entries].flatMap(([id, entry]) =>
        [...entry[kind]].map(([key, Component]) => (
          <Component key={`${id}/${key}`} serverId={serverId} agentId={agentId} />
        )),
      )}
    </>
  );
}
/**
 * Reads live host state at send time, including queued sends: a disabled feature contributes
 * nothing and must not consume its pending state.
 */
export function prepareBuiltinTurn(input: {
  serverId?: string | null;
  agentId: string;
  text: string;
}): BuiltinTurnPreparation {
  const serverId = input.serverId ?? "";
  const info = useSessionStore.getState().sessions[serverId]?.serverInfo;
  const preparations = [...builtinClientRegistry.visible(info).values()].flatMap((entry) =>
    entry.turnPreparers.map((prepare) =>
      prepare({ serverId, agentId: input.agentId, text: input.text }),
    ),
  );
  const skillIds = preparations.flatMap((preparation) => preparation.skillIds ?? []);
  return {
    skillIds: skillIds.length > 0 ? skillIds : undefined,
    commit: () => {
      for (const preparation of preparations) preparation.commit();
    },
  };
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
/** `before` renders the destinations placed at that core slot; omitted, the unplaced ones. */
export function BuiltinSidebarDestinations({ before }: { before?: string }) {
  const pathname = usePathname();
  const items = useBuiltinDestinations(pathname).filter((item) => item.before === before);
  return (
    <>
      {items.map((item) => (
        <BuiltinSidebarDestination key={item.key} item={item} />
      ))}
    </>
  );
}
