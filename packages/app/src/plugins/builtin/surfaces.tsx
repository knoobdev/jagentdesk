import { router, usePathname } from "expo-router";
import { useCallback, type ComponentType } from "react";
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
  BuiltinComposerDockProps,
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
