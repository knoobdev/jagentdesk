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
import { Activity, CircleDashed, SquareTerminal } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ComposerTrackPill, ComposerTrackRow } from "@/composer/tracks";
import { LiveElapsed } from "@/components/message";
import { Button } from "@/components/ui/button";
import type { Theme } from "@/styles/theme";
import type { JAgentDeskAgentBackgroundWorkItem } from "@jagentdesk/client";
import { backgroundWorkText } from "./presentation";
import {
  consumeBackgroundWorkTrackOpen,
  getBackgroundWorkModel,
  useBackgroundWorkTrackOpenRequest,
  type BackgroundWorkModel,
} from "./shared";
export { createHostBackgroundWorkModel } from "./host";

const ThemedSquareTerminal = withUnistyles(SquareTerminal);
const ThemedActivity = withUnistyles(Activity);
const ThemedCircleDashed = withUnistyles(CircleDashed);
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

type BackgroundWorkKind = "shell" | "monitor" | "heartbeat" | "other";

function kindKey(kind: string): BackgroundWorkKind {
  if (kind === "shell" || kind === "monitor" || kind === "heartbeat") return kind;
  return "other";
}

function KindIcon({ kind }: { kind: BackgroundWorkKind }): ReactElement {
  if (kind === "shell")
    return <ThemedSquareTerminal size={14} uniProps={foregroundMutedColorMapping} />;
  if (kind === "monitor" || kind === "heartbeat")
    return <ThemedActivity size={14} uniProps={foregroundMutedColorMapping} />;
  return <ThemedCircleDashed size={14} uniProps={foregroundMutedColorMapping} />;
}

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
}: BackgroundWorkTrackProps): ReactElement | null {
  const { t } = useTranslation();
  const model = getBackgroundWorkModel(serverId, agentId);
  const { snapshot, rows, runningCount } = useTrackRows(model);
  const [open, setOpen] = useState(false);
  // A sidebar line asks for the track to open when it navigates here.
  const openRequest = useBackgroundWorkTrackOpenRequest(serverId, agentId);
  useEffect(() => {
    if (openRequest === 0) return;
    setOpen(true);
    consumeBackgroundWorkTrackOpen(serverId, agentId);
  }, [agentId, openRequest, serverId]);

  const running = runningCount ?? count;
  if (running === 0 && rows.length === 0) return null;

  let label = t("message.backgroundWork.finishedHeader", { count: rows.length });
  if (running === 1) label = t("message.backgroundWork.pillOne");
  else if (running > 1) label = t("message.backgroundWork.pillMany", { count: running });

  return (
    <ComposerTrackPill
      testID="background-work"
      panelTitle={t("message.backgroundWork.title")}
      segments={[{ bucket: running > 0 ? "running" : "done", text: label }]}
      open={open}
      onOpenChange={setOpen}
    >
      <BackgroundWorkRows model={model} rows={rows} status={snapshot.status} />
    </ComposerTrackPill>
  );
}

function BackgroundWorkRows({
  model,
  rows,
  status,
}: {
  model: BackgroundWorkModel;
  rows: TrackRow[];
  status: ReturnType<BackgroundWorkModel["getSnapshot"]>["status"];
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
        <ComposerTrackRow
          key={`${row.state}:${row.item.stopToken ?? row.item.id}`}
          testID="background-work-row"
        >
          <View style={styles.row}>
            <BackgroundWorkRowContent row={row} model={model} ready={status === "ready"} />
          </View>
        </ComposerTrackRow>
      ))}
    </>
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
  const kind = kindKey(item.kind);
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
      <KindIcon kind={kind} />
      <Text
        style={labelIsCommand ? styles.commandLabel : styles.label}
        numberOfLines={1}
        accessibilityLabel={title}
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
}));
