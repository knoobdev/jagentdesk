import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { ComposerTrackPill, ComposerTrackRow, useComposerTrackPanelRoom } from "@/composer/tracks";
import { LiveElapsed } from "@/components/message";
import { Button } from "@/components/ui/button";
import { useMenuContext, type MenuPageDefinition } from "@/components/ui/menu";
import { useIsCompactFormFactor } from "@/constants/layout";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import type { JAgentDeskAgentBackgroundWorkItem } from "@jagentdesk/client";
import { BackgroundWorkDetail } from "./detail";
import { backgroundWorkKind, BackgroundWorkKindIcon } from "./kind";
import { backgroundWorkText } from "./presentation";
import {
  consumeBackgroundWorkTrackOpen,
  getBackgroundWorkModel,
  useBackgroundWorkTrackOpenRequest,
  type BackgroundWorkModel,
} from "./shared";
export { createHostBackgroundWorkModel } from "./host";

type TrackRow =
  | { state: "live"; item: JAgentDeskAgentBackgroundWorkItem }
  | { state: "stopping"; item: JAgentDeskAgentBackgroundWorkItem; failed: boolean }
  | { state: "finished"; item: JAgentDeskAgentBackgroundWorkItem };

function useTrackRows(model: BackgroundWorkModel) {
  const snapshot = useSyncedSnapshot(model);
  const { items, stops, finished } = snapshot;
  return useMemo(() => {
    const rows: TrackRow[] = (items ?? []).map((item) => ({ state: "live", item }));
    const liveTokens = new Set((items ?? []).map((item) => item.stopToken));
    const stopping = Object.values(stops ?? {}).filter(
      (entry) => !liveTokens.has(entry.item.stopToken),
    );
    for (const entry of stopping)
      rows.push({ state: "stopping", item: entry.item, failed: entry.status === "error" });
    const stoppingIds = new Set(stopping.map((entry) => entry.item.id));
    for (const entry of Object.values(finished ?? {}))
      if (!stoppingIds.has(entry.item.id)) rows.push({ state: "finished", item: entry.item });
    return { snapshot, rows, runningCount: items?.length ?? null };
  }, [finished, items, snapshot, stops]);
}

function useSyncedSnapshot(model: BackgroundWorkModel) {
  return useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
}

export interface BackgroundWorkTrackProps {
  serverId: string;
  agentId: string;
  /** Running tasks from the directory summary; shown until the live list arrives. */
  count: number;
  /** Desktop: opens a task's detail as a read-only workspace tab (ADR-0062). */
  onOpenInTab?: (itemId: string) => void;
}

/** Room for the header, command and output; the panel still fits the chat area above the pills. */
const POPOVER_DETAIL_MAX_HEIGHT = 720;

function detailPageId(itemId: string): string {
  return `background-work-detail:${itemId}`;
}

/**
 * The agent's background work as one pill in the composer's track rail (spec 38 §4.4b, Paseo
 * #6220): the running ring and the count; the panel lists each task with Stop, and work that ended
 * with Dismiss. A popover on wide screens, a sheet on compact ones.
 */
export function BackgroundWorkTrack({
  serverId,
  agentId,
  count,
  onOpenInTab,
}: BackgroundWorkTrackProps): ReactElement | null {
  const { t } = useTranslation();
  const model = getBackgroundWorkModel(serverId, agentId);
  const { snapshot, rows, runningCount } = useTrackRows(model);
  const [open, setOpenState] = useState(false);
  // Desktop shows one task's detail in place of the list; phones push a sheet page instead.
  const [selected, setSelected] = useState<string | null>(null);
  const isCompact = useIsCompactFormFactor();
  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    if (!next) setSelected(null);
  }, []);
  const pages = useMemo<MenuPageDefinition[] | undefined>(() => {
    if (!isCompact) return undefined;
    // Full-height pages: the detail draws its own Back row, and the output takes the rest.
    return rows.map((row) => ({
      id: detailPageId(row.item.id),
      fill: true,
      content: <SheetDetailPage serverId={serverId} agentId={agentId} item={row.item} />,
    }));
  }, [agentId, isCompact, rows, serverId]);
  // A sidebar line asks for the track to open when it navigates here.
  const openRequest = useBackgroundWorkTrackOpenRequest(serverId, agentId);
  useEffect(() => {
    if (openRequest === 0) return;
    setOpen(true);
    consumeBackgroundWorkTrackOpen(serverId, agentId);
  }, [agentId, openRequest, serverId, setOpen]);
  const closeDetail = useCallback(() => setSelected(null), []);
  const openSelectedInTab = useCallback(() => {
    if (!selected || !onOpenInTab) return;
    setOpen(false);
    onOpenInTab(selected);
  }, [onOpenInTab, selected, setOpen]);

  const running = runningCount ?? count;
  if (running === 0 && rows.length === 0) return null;

  let label = t("message.backgroundWork.finishedHeader", { count: rows.length });
  if (running === 1) label = t("message.backgroundWork.pillOne");
  else if (running > 1) label = t("message.backgroundWork.pillMany", { count: running });

  const selectedRow = selected ? rows.find((row) => row.item.id === selected) : undefined;
  const showsDetail = !isCompact && selected !== null;
  return (
    <ComposerTrackPill
      testID="background-work"
      panelTitle={t("message.backgroundWork.title")}
      segments={[{ bucket: running > 0 ? "running" : "done", text: label }]}
      open={open}
      onOpenChange={setOpen}
      pages={pages}
      panelMaxHeight={showsDetail ? POPOVER_DETAIL_MAX_HEIGHT : undefined}
      panelSurfaceStyle={showsDetail ? styles.detailSurface : undefined}
    >
      {!isCompact && selected ? (
        <PopoverDetail
          serverId={serverId}
          agentId={agentId}
          itemId={selected}
          fallbackItem={selectedRow?.item ?? null}
          onBack={closeDetail}
          onOpenInTab={onOpenInTab ? openSelectedInTab : undefined}
        />
      ) : (
        <BackgroundWorkRows
          model={model}
          rows={rows}
          status={snapshot.status}
          onSelect={isCompact ? undefined : setSelected}
          opensPages={isCompact}
        />
      )}
    </ComposerTrackPill>
  );
}

function PopoverDetail({
  serverId,
  agentId,
  itemId,
  fallbackItem,
  onBack,
  onOpenInTab,
}: {
  serverId: string;
  agentId: string;
  itemId: string;
  fallbackItem: JAgentDeskAgentBackgroundWorkItem | null;
  onBack: () => void;
  onOpenInTab?: () => void;
}): ReactElement {
  const room = useComposerTrackPanelRoom();
  return (
    <BackgroundWorkDetail
      serverId={serverId}
      agentId={agentId}
      itemId={itemId}
      fallbackItem={fallbackItem}
      variant="popover"
      popoverMaxHeight={
        room === null ? POPOVER_DETAIL_MAX_HEIGHT : Math.min(room, POPOVER_DETAIL_MAX_HEIGHT)
      }
      onBack={onBack}
      onOpenInTab={onOpenInTab}
      onDismissed={onBack}
    />
  );
}

function SheetDetailPage({
  serverId,
  agentId,
  item,
}: {
  serverId: string;
  agentId: string;
  item: JAgentDeskAgentBackgroundWorkItem;
}): ReactElement {
  const { goBack } = useMenuContext("BackgroundWorkDetailPage");
  const back = useCallback(() => {
    goBack();
  }, [goBack]);
  return (
    <BackgroundWorkDetail
      serverId={serverId}
      agentId={agentId}
      itemId={item.id}
      fallbackItem={item}
      variant="sheet"
      onBack={back}
      onDismissed={back}
    />
  );
}

function BackgroundWorkRows({
  model,
  rows,
  status,
  onSelect,
  opensPages,
}: {
  model: BackgroundWorkModel;
  rows: TrackRow[];
  status: ReturnType<BackgroundWorkModel["getSnapshot"]>["status"];
  /** Desktop: show a task's detail in place of the list. */
  onSelect?: (itemId: string) => void;
  /** Phones: each row opens its sheet page. */
  opensPages: boolean;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <>
      {status === "loading" || status === "stale" ? (
        <ComposerTrackRow>
          <Text style={styles.facts}>{t("message.backgroundWork.waiting")}</Text>
        </ComposerTrackRow>
      ) : null}
      {status === "error" ? (
        <>
          <ComposerTrackRow>
            <Text style={styles.facts}>{t("message.backgroundWork.error")}</Text>
          </ComposerTrackRow>
          <ComposerTrackRow
            onPress={model.retry}
            closeOnSelect={false}
            accessibilityLabel={t("message.backgroundWork.retry")}
          >
            <Text style={styles.label}>{t("message.backgroundWork.retry")}</Text>
          </ComposerTrackRow>
        </>
      ) : null}
      {rows.map((row) => (
        <BackgroundWorkRow
          key={`${row.state}:${row.item.stopToken ?? row.item.id}`}
          row={row}
          model={model}
          ready={status === "ready"}
          onSelect={onSelect}
          opensPage={opensPages}
        />
      ))}
    </>
  );
}

function BackgroundWorkRow({
  row,
  model,
  ready,
  onSelect,
  opensPage,
}: {
  row: TrackRow;
  model: BackgroundWorkModel;
  ready: boolean;
  onSelect?: (itemId: string) => void;
  opensPage: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const itemId = row.item.id;
  const select = useCallback(() => onSelect?.(itemId), [itemId, onSelect]);
  return (
    <ComposerTrackRow
      testID="background-work-row"
      opensPage={opensPage ? detailPageId(itemId) : undefined}
      onPress={onSelect ? select : undefined}
      closeOnSelect={false}
      accessibilityLabel={t("message.backgroundWork.detail.open", {
        label: row.item.command ?? row.item.description ?? row.item.kind,
      })}
    >
      <View style={styles.row}>
        <BackgroundWorkRowContent row={row} model={model} ready={ready} />
      </View>
    </ComposerTrackRow>
  );
}

function BackgroundWorkRowContent({
  row,
  model,
  ready,
}: {
  row: TrackRow;
  model: BackgroundWorkModel;
  ready: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const { item } = row;
  const kind = backgroundWorkKind(item.kind);
  const kindLabel = t(`message.backgroundWork.${kind}`);
  const { title, command } = backgroundWorkText(item, kindLabel);
  const stop = useCallback(() => {
    void model.stopItem(item);
  }, [model, item]);
  const dismiss = useCallback(() => {
    if (row.state === "stopping") model.dismissStop(item.stopToken ?? "");
    else model.dismissFinished(item.id);
  }, [model, item.id, item.stopToken, row.state]);
  // The command is the label when there is one: it is what the agent ran and what the user
  // recognises; the description becomes the accessible name.
  const label = command ?? title;
  const labelIsCommand = Boolean(command ?? item.command);
  return (
    <>
      <BackgroundWorkKindIcon kind={kind} />
      <Text
        style={labelIsCommand ? styles.commandLabel : styles.label}
        numberOfLines={1}
        accessibilityLabel={title}
        dataSet={labelIsCommand ? CODE_SURFACE_DATASET : undefined}
      >
        {label}
      </Text>
      {row.state === "live" ? (
        <LiveElapsed startedAt={new Date(item.startedAt)} active style={styles.facts} />
      ) : null}
      {row.state === "stopping" && !row.failed ? (
        <Text style={styles.facts}>{t("message.backgroundWork.stopping")}</Text>
      ) : null}
      {row.state === "stopping" && row.failed ? (
        <Text style={styles.facts} numberOfLines={1}>
          {t("message.backgroundWork.stopError")}
        </Text>
      ) : null}
      {row.state === "finished" ? (
        <Text style={styles.facts}>{t("message.backgroundWork.notRunning")}</Text>
      ) : null}
      {row.state === "live" && item.canStop && ready ? (
        <Button
          variant="ghost"
          size="sm"
          accessibilityLabel={`${t("message.backgroundWork.stop")} ${title}`}
          onPress={stop}
          testID="background-work-stop"
        >
          {t("message.backgroundWork.stop")}
        </Button>
      ) : null}
      {row.state === "finished" || (row.state === "stopping" && row.failed) ? (
        <Button variant="ghost" size="sm" onPress={dismiss} testID="background-work-dismiss">
          {t("message.backgroundWork.dismiss")}
        </Button>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  // `flexBasis: "auto"` so the row's text reaches the panel's measurement — see subagents/track.
  row: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "auto",
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  label: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "auto",
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  commandLabel: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "auto",
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
  },
  facts: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  // The detail is a panel, not a menu: radius 12 and the standard border (spec 04 §27c).
  detailSurface: {
    borderRadius: theme.borderRadius.xl,
    borderColor: theme.colors.border,
  },
}));
