import { useCallback, useState, type ReactElement, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import * as Clipboard from "expo-clipboard";
import { StyleSheet } from "react-native-unistyles";
import type {
  JAgentDeskAgentBackgroundWorkDetail,
  JAgentDeskAgentBackgroundWorkItem,
} from "@jagentdesk/client";
import { providerDisplayLabel } from "@/continuity/provider-model-choices";
import { LiveElapsed } from "@/components/message";
import { Button } from "@/components/ui/button";
import { useSessionStore } from "@/stores/session-store";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { formatDuration } from "@/utils/time";
import { BackgroundWorkOutputView } from "./output-view";
import { useBackgroundWorkDetail } from "./use-detail";

export interface BackgroundWorkDetailProps {
  serverId: string;
  agentId: string;
  itemId: string;
  /** What the list already knows, shown until the detail arrives. */
  fallbackItem?: JAgentDeskAgentBackgroundWorkItem | null;
  /** Desktop popover: opens the same view as a read-only workspace tab. */
  onOpenInTab?: () => void;
  /** Called after Dismiss removed the ended task from the list. */
  onDismissed?: () => void;
  /** "panel" sizes the output for a popover or sheet; "tab" lets it fill the pane. */
  variant: "panel" | "tab";
  outputHeight?: number;
}

type DetailStatus = "running" | "finished" | "failed" | "stopped";

/** The live list wins: a task it still lists is running whatever an older detail said. */
function detailStatus(
  liveItem: JAgentDeskAgentBackgroundWorkItem | null,
  detail: JAgentDeskAgentBackgroundWorkDetail | null,
): DetailStatus {
  if (liveItem) return "running";
  const status = detail?.status;
  if (status === "failed" || status === "stopped") return status;
  return "finished";
}

function isStopping(
  model: ReturnType<typeof useBackgroundWorkDetail>["model"],
  liveItem: JAgentDeskAgentBackgroundWorkItem | null,
): boolean {
  const token = liveItem?.stopToken;
  return token ? model.getSnapshot().stops?.[token]?.status === "pending" : false;
}

function detailTitle(
  item: Pick<JAgentDeskAgentBackgroundWorkItem, "description" | "command">,
  kindLabel: string,
): string {
  return item.description?.trim() || item.command?.trim() || kindLabel;
}

/**
 * Everything about one background task (spec 04 §27c, ADR-0062): its full label and command,
 * owner, folder, timing, status and exit code, Stop or Dismiss, and the live output.
 */
export function BackgroundWorkDetail({
  serverId,
  agentId,
  itemId,
  fallbackItem,
  onOpenInTab,
  onDismissed,
  variant,
  outputHeight = 240,
}: BackgroundWorkDetailProps): ReactElement {
  const { t } = useTranslation();
  const { state, liveItem, model } = useBackgroundWorkDetail({ serverId, agentId, itemId });
  const detail = state.status === "ready" ? state.detail : null;
  const item = liveItem ?? detail ?? fallbackItem ?? null;
  const stop = useCallback(() => {
    if (liveItem) void model.stopItem(liveItem);
  }, [liveItem, model]);
  const dismiss = useCallback(() => {
    model.dismissFinished(itemId);
    onDismissed?.();
  }, [itemId, model, onDismissed]);

  if (!item) {
    return (
      <View style={styles.container}>
        <Text style={styles.muted}>{detailStateText(t, state)}</Text>
      </View>
    );
  }

  const kindLabel = t(`message.backgroundWork.${kindKey(item.kind)}`);
  const status = detailStatus(liveItem, detail);
  const stopping = isStopping(model, liveItem);

  return (
    <View
      style={variant === "tab" ? styles.containerFill : styles.container}
      testID="background-work-detail"
    >
      <Text style={styles.title} selectable testID="background-work-detail-title">
        {detailTitle(item, kindLabel)}
      </Text>
      {item.command ? <CommandBlock command={item.command} /> : null}
      <DetailFacts
        serverId={serverId}
        agentId={agentId}
        kindLabel={kindLabel}
        startedAt={item.startedAt}
        status={status}
        detail={detail}
      />
      <DetailActions
        status={status}
        canStop={liveItem?.canStop === true}
        stopping={stopping}
        onStop={stop}
        onDismiss={dismiss}
        onOpenInTab={onOpenInTab}
      />
      {detail ? (
        <BackgroundWorkOutputView
          serverId={serverId}
          agentId={agentId}
          itemId={itemId}
          outputAvailable={detail.outputAvailable}
          providerLabel={providerDisplayLabel(detail.provider)}
          height={variant === "tab" ? undefined : outputHeight}
        />
      ) : (
        <Text style={styles.muted}>{detailStateText(t, state)}</Text>
      )}
    </View>
  );
}

/** The full command, wrapped and selectable, with Copy (A4.27c.2). */
function CommandBlock({ command }: { command: string }): ReactElement {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void Clipboard.setStringAsync(command).then(() => setCopied(true));
  }, [command]);
  return (
    <View style={styles.commandBlock}>
      <Text
        style={styles.command}
        selectable
        dataSet={CODE_SURFACE_DATASET}
        testID="background-work-detail-command"
      >
        {command}
      </Text>
      <View style={styles.commandActions}>
        <Button variant="ghost" size="sm" onPress={copy} testID="background-work-detail-copy">
          {copied
            ? t("message.backgroundWork.detail.copied")
            : t("message.backgroundWork.detail.copy")}
        </Button>
      </View>
    </View>
  );
}

function DetailFacts({
  serverId,
  agentId,
  kindLabel,
  startedAt,
  status,
  detail,
}: {
  serverId: string;
  agentId: string;
  kindLabel: string;
  startedAt: string;
  status: DetailStatus;
  detail: JAgentDeskAgentBackgroundWorkDetail | null;
}): ReactElement {
  const { t } = useTranslation();
  const agentTitle = useSessionStore(
    (store) => store.sessions[serverId]?.agents?.get(agentId)?.title ?? null,
  );
  const started = new Date(startedAt);
  const running = status === "running";
  const exitCode = detail?.exitCode ?? null;
  return (
    <View style={styles.facts}>
      <Fact label={t("message.backgroundWork.detail.kind")}>{kindLabel}</Fact>
      {agentTitle ? (
        <Fact label={t("message.backgroundWork.detail.agent")}>{agentTitle}</Fact>
      ) : null}
      {detail?.cwd ? (
        <Fact label={t("message.backgroundWork.detail.folder")} mono>
          {detail.cwd}
        </Fact>
      ) : null}
      <Fact label={t("message.backgroundWork.detail.started")}>{started.toLocaleString()}</Fact>
      <Fact
        label={
          running
            ? t("message.backgroundWork.detail.runningFor")
            : t("message.backgroundWork.detail.ranFor")
        }
      >
        <RunTime startedAt={started} endedAt={running ? null : detail?.endedAt} />
      </Fact>
      <Fact
        label={t("message.backgroundWork.detail.status")}
        testID="background-work-detail-status"
      >
        {t(`message.backgroundWork.detail.statusValue.${status}`)}
      </Fact>
      {exitCode !== null ? (
        <Fact
          label={t("message.backgroundWork.detail.exitCode")}
          testID="background-work-detail-exit"
        >
          {String(exitCode)}
        </Fact>
      ) : null}
    </View>
  );
}

function DetailActions({
  status,
  canStop,
  stopping,
  onStop,
  onDismiss,
  onOpenInTab,
}: {
  status: DetailStatus;
  canStop: boolean;
  stopping: boolean;
  onStop: () => void;
  onDismiss: () => void;
  onOpenInTab?: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.actions}>
      {status === "running" && canStop ? (
        <Button
          variant="outline"
          size="sm"
          onPress={onStop}
          loading={stopping}
          testID="background-work-detail-stop"
        >
          {stopping ? t("message.backgroundWork.stopping") : t("message.backgroundWork.stop")}
        </Button>
      ) : null}
      {status === "running" ? null : (
        <Button
          variant="outline"
          size="sm"
          onPress={onDismiss}
          testID="background-work-detail-dismiss"
        >
          {t("message.backgroundWork.dismiss")}
        </Button>
      )}
      {onOpenInTab ? (
        <Button
          variant="ghost"
          size="sm"
          onPress={onOpenInTab}
          testID="background-work-detail-open-tab"
        >
          {t("message.backgroundWork.detail.openInTab")}
        </Button>
      ) : null}
    </View>
  );
}

function RunTime({
  startedAt,
  endedAt,
}: {
  startedAt: Date;
  endedAt: string | null | undefined;
}): ReactElement {
  if (endedAt === null) return <LiveElapsed startedAt={startedAt} active style={styles.value} />;
  const ended = endedAt ? Date.parse(endedAt) : Number.NaN;
  if (!Number.isFinite(ended)) return <Text style={styles.value}>—</Text>;
  return (
    <Text style={styles.value}>{formatDuration(Math.max(0, ended - startedAt.getTime()))}</Text>
  );
}

function Fact({
  label,
  children,
  mono = false,
  testID,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
  testID?: string;
}): ReactElement {
  return (
    <View style={styles.fact} testID={testID}>
      <Text style={styles.factLabel}>{label}</Text>
      {typeof children === "string" ? (
        <Text
          style={mono ? styles.valueMono : styles.value}
          selectable
          dataSet={mono ? CODE_SURFACE_DATASET : undefined}
        >
          {children}
        </Text>
      ) : (
        children
      )}
    </View>
  );
}

function kindKey(kind: string): "shell" | "monitor" | "heartbeat" | "other" {
  if (kind === "shell" || kind === "monitor" || kind === "heartbeat") return kind;
  return "other";
}

function detailStateText(
  t: ReturnType<typeof useTranslation>["t"],
  state: ReturnType<typeof useBackgroundWorkDetail>["state"],
): string {
  if (state.status === "update-host") return t("message.backgroundWork.detail.updateHost");
  if (state.status === "error") return t("message.backgroundWork.detail.notFound");
  return t("message.backgroundWork.detail.loading");
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
  },
  containerFill: {
    flex: 1,
    minHeight: 0,
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  title: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  commandBlock: {
    flexDirection: "row",
    alignItems: "flex-start",
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    paddingVertical: theme.spacing[1],
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[1],
    gap: theme.spacing[2],
  },
  command: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
    paddingVertical: theme.spacing[1],
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  commandActions: {
    flexShrink: 0,
  },
  facts: { gap: theme.spacing[1] },
  fact: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
  },
  factLabel: {
    width: 96,
    flexShrink: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  value: {
    flex: 1,
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  valueMono: {
    flex: 1,
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  muted: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
