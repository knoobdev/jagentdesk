import { router, usePathname } from "expo-router";
import { useCallback, type ComponentType } from "react";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { usePanelStore } from "@/stores/panel-store";
import { useMemo, useSyncExternalStore } from "react";
import { useSessionStore } from "@/stores/session-store";
import { useHosts } from "@/runtime/host-runtime";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useIsCompactFormFactor } from "@/constants/layout";
import { hostSupportsCapability } from "@/utils/server-info-capabilities";
import { mobileNavTileTestID } from "@/components/sidebar/nav-test-ids";
import { orderAppNavItems } from "@/components/sidebar/nav-order";
import type { AppNavItem } from "@/components/sidebar/use-app-nav";
import { builtinClientRegistry } from "./loaded";
import type {
  BuiltinAgentProps,
  BuiltinAttachmentPillProps,
  BuiltinClientProps,
  BuiltinComposerDockProps,
  BuiltinDestination,
  BuiltinSidePanelProps,
  BuiltinUserMessageBodyProps,
  BuiltinScreen as ScreenProps,
  BuiltinTurnPreparation,
} from "./host";
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
  const info = useSessionStore((state) => state.sessions[serverId]?.serverInfo);
  const compact = useIsCompactFormFactor();
  const destinations = useMemo(
    () =>
      [...entries.values()]
        .flatMap((entry) => (compact ? entry.mobileEntries : entry.destinations))
        .filter(
          ({ requiresFeature, hostCapabilities }) =>
            (!requiresFeature ||
              (features as Record<string, unknown> | undefined)?.[requiresFeature] === true) &&
            (!hostCapabilities || hostSupportsCapability(info, hostCapabilities)),
        ),
    [compact, entries, features, info],
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
            sidebarTestID: destination.sidebarTestID,
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
export function BuiltinWorkspaceHeaderControls({ serverId }: BuiltinClientProps) {
  const entries = useBuiltinClientContributions(serverId);
  return (
    <>
      {[...entries].flatMap(([id, entry]) =>
        [...entry.workspaceHeader].map(([key, Control]) => (
          <Control key={`${id}/${key}`} serverId={serverId} />
        )),
      )}
    </>
  );
}
export function BuiltinAgentItems({
  serverId,
  agentId,
  kind,
}: BuiltinAgentProps & { kind: "agentControls" | "agentPanel" | "agentHeader" }) {
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
export function BuiltinComposerDocks(props: BuiltinComposerDockProps) {
  const entries = useBuiltinClientContributions(props.serverId);
  return (
    <>
      {[...entries].flatMap(([id, entry]) =>
        [...entry.composerDocks].map(([key, Dock]) => <Dock key={`${id}/${key}`} {...props} />),
      )}
    </>
  );
}
export function BuiltinAgentSettingsCards({ serverId }: BuiltinClientProps) {
  const entries = useBuiltinClientContributions(serverId);
  const cards = [...entries]
    .flatMap(([id, entry]) =>
      [...entry.agentSettings].map(([key, card]) => ({
        key: `${id}/${key}`,
        component: card.component,
        order: card.order,
      })),
    )
    .sort((left, right) => left.order - right.order);
  return (
    <>
      {cards.map(({ key, component: Card }) => (
        <Card key={key} serverId={serverId} />
      ))}
    </>
  );
}
/** Side panels beside the agent chat: wide layouts pass `containerWidth`, compact ones omit it. */
export function BuiltinAgentSidePanels({
  containerWidth,
  ...props
}: BuiltinSidePanelProps & { containerWidth?: number }) {
  const entries = useBuiltinClientContributions(props.serverId);
  return (
    <>
      {[...entries].flatMap(([id, entry]) =>
        [...entry.sidePanels].map(([key, { panel: Panel, sheet: Sheet }]) =>
          containerWidth === undefined ? (
            <Sheet key={`${id}/${key}`} {...props} />
          ) : (
            <Panel key={`${id}/${key}`} {...props} containerWidth={containerWidth} />
          ),
        ),
      )}
    </>
  );
}
/** The enabled message body renderer for this host, or null to render plain text. */
export function useBuiltinUserMessageBody(
  serverId: string | undefined,
): ComponentType<BuiltinUserMessageBodyProps> | null {
  const entries = useBuiltinClientContributions(serverId ?? "");
  return [...entries.values()].find((entry) => entry.userMessageBody)?.userMessageBody ?? null;
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
      testID={item.sidebarTestID ?? mobileNavTileTestID(item.key, `sidebar-${item.key}-nav`)}
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
        : orderAppNavItems(items.filter((item) => !except?.includes(item.key)))
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
