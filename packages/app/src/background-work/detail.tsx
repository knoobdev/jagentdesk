import { useCallback, useState, type ReactElement, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import { useTranslation } from "react-i18next";
import { Check, ChevronLeft, Maximize2, Square, X } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type {
  JAgentDeskAgentBackgroundWorkDetail,
  JAgentDeskAgentBackgroundWorkItem,
} from "@jagentdesk/client";
import { providerDisplayLabel } from "@/continuity/provider-model-choices";
import { LiveElapsed } from "@/components/message";
import { StatusRing } from "@/components/status-ring";
import { STATUS_RING_HALO_INSET } from "@/components/status-ring/geometry";
import { Button } from "@/components/ui/button";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { StatusBadge } from "@/components/ui/status-badge";
import { useSessionStore } from "@/stores/session-store";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { formatDuration } from "@/utils/time";
import { shortenPath } from "@/utils/shorten-path";
import { CommandFence } from "./command-fence";
import { truncatePathMiddle } from "./format";
import { DetailIconAction } from "./icon-action";
import { backgroundWorkKind, BackgroundWorkKindIcon } from "./kind";
import { BackgroundWorkOutputView } from "./output-view";
import { useBackgroundWorkDetail } from "./use-detail";

const ThemedChevronLeft = withUnistyles(ChevronLeft, mutedIconColorMapping);
const ThemedMaximize = withUnistyles(Maximize2, mutedIconColorMapping);
const ThemedSquare = withUnistyles(Square, mutedIconColorMapping);
const ThemedSuccessCheck = withUnistyles(Check, (theme: Theme) => ({
  color: theme.colors.statusSuccess,
}));
const ThemedFailedX = withUnistyles(X, (theme: Theme) => ({ color: theme.colors.statusDanger }));

/**
 * Where the detail is shown. The popover is a fixed 560 px column with a fixed output box; the
 * phone sheet page and the workspace tab fill their space and let the output take what is left.
 */
export type BackgroundWorkDetailVariant = "popover" | "sheet" | "tab";

export interface BackgroundWorkDetailProps {
  serverId: string;
  agentId: string;
  itemId: string;
  variant: BackgroundWorkDetailVariant;
  /** What the list already knows, shown until the detail arrives. */
  fallbackItem?: JAgentDeskAgentBackgroundWorkItem | null;
  /** Leads the header row with "‹ Background work" (popover, phone page). */
  onBack?: () => void;
  /** Desktop popover: opens the same view as a read-only workspace tab. */
  onOpenInTab?: () => void;
  /** Called after Dismiss removed the ended task from the list. */
  onDismissed?: () => void;
  /** Popover: the height it may take; the output box gives up height to stay inside it. */
  popoverMaxHeight?: number;
}

type DetailStatus = "running" | "finished" | "failed" | "stopped";

/** The popover's output box (spec 04 §27c), and the least it shrinks to on a short window. */
const POPOVER_OUTPUT_HEIGHT = 280;
const POPOVER_OUTPUT_MIN_HEIGHT = 160;
/** Width of the popover column; the surface still fits it inside the chat area. */
export const POPOVER_DETAIL_WIDTH = 560;
/** Average advance of the 13 px UI font, for fitting the folder onto its line. */
const META_CHAR_WIDTH = 6.5;

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
 * Everything about one background task (spec 04 §27c, ADR-0062), laid out like the app's Shell
 * tool call: a header row with Back and the task's actions, the label, one status line and one
 * owner line, the command in a fence, and the live output in a fence-styled terminal.
 */
export function BackgroundWorkDetail({
  serverId,
  agentId,
  itemId,
  variant,
  fallbackItem,
  onBack,
  onOpenInTab,
  onDismissed,
  popoverMaxHeight,
}: BackgroundWorkDetailProps): ReactElement {
  const { t } = useTranslation();
  const popoverOutput = usePopoverOutputHeight(popoverMaxHeight);
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
      <DetailFrame variant={variant} onLayout={popoverOutput.onLayout}>
        {onBack ? <DetailHeader onBack={onBack} /> : null}
        <Text style={styles.stateText}>{detailStateText(t, state)}</Text>
      </DetailFrame>
    );
  }

  const kind = backgroundWorkKind(item.kind);
  const kindLabel = t(`message.backgroundWork.${kind}`);
  const status = detailStatus(liveItem, detail);
  const canStop = status === "running" && liveItem?.canStop === true;

  return (
    <DetailFrame variant={variant} onLayout={popoverOutput.onLayout}>
      <DetailHeader onBack={onBack}>
        {onOpenInTab ? (
          <DetailIconAction
            label={t("message.backgroundWork.detail.openInTab")}
            onPress={onOpenInTab}
            testID="background-work-detail-open-tab"
          >
            <ThemedMaximize size={ICON_SIZE.sm} />
          </DetailIconAction>
        ) : null}
        {canStop ? (
          <Button
            variant="outline"
            size="sm"
            onPress={stop}
            loading={isStopping(model, liveItem)}
            testID="background-work-detail-stop"
          >
            {isStopping(model, liveItem)
              ? t("message.backgroundWork.stopping")
              : t("message.backgroundWork.stop")}
          </Button>
        ) : null}
        {status === "running" ? null : (
          <Button
            variant="outline"
            size="sm"
            onPress={dismiss}
            testID="background-work-detail-dismiss"
          >
            {t("message.backgroundWork.dismiss")}
          </Button>
        )}
      </DetailHeader>
      <View style={styles.summary}>
        <Text
          style={styles.title}
          numberOfLines={2}
          selectable
          testID="background-work-detail-title"
        >
          {detailTitle(item, kindLabel)}
        </Text>
        <StatusLine
          kind={kind}
          kindLabel={kindLabel}
          status={status}
          startedAt={item.startedAt}
          detail={detail}
        />
        <OwnerLine serverId={serverId} agentId={agentId} cwd={detail?.cwd ?? null} />
      </View>
      {item.command ? <CommandFence command={item.command} /> : null}
      {detail ? (
        <BackgroundWorkOutputView
          serverId={serverId}
          agentId={agentId}
          itemId={itemId}
          outputAvailable={detail.outputAvailable}
          providerLabel={providerDisplayLabel(detail.provider)}
          height={variant === "popover" ? popoverOutput.height : undefined}
        />
      ) : (
        <Text style={styles.stateText}>{detailStateText(t, state)}</Text>
      )}
    </DetailFrame>
  );
}

/**
 * The popover's output box: 280 px when the chat area has the room, less (down to 160) when it
 * does not, so the panel shows all of the detail instead of scrolling its own frame. The frame's
 * height without the box is measured once laid out; the box takes what is left.
 */
function usePopoverOutputHeight(maxHeight: number | undefined): {
  height: number;
  onLayout: (event: LayoutChangeEvent) => void;
} {
  const [height, setHeight] = useState(POPOVER_OUTPUT_HEIGHT);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      if (maxHeight === undefined) return;
      const rest = event.nativeEvent.layout.height - height;
      const fit = Math.min(
        POPOVER_OUTPUT_HEIGHT,
        Math.max(POPOVER_OUTPUT_MIN_HEIGHT, Math.floor(maxHeight - rest)),
      );
      if (fit !== height) setHeight(fit);
    },
    [height, maxHeight],
  );
  return { height, onLayout };
}

function DetailFrame({
  variant,
  onLayout,
  children,
}: {
  variant: BackgroundWorkDetailVariant;
  onLayout?: (event: LayoutChangeEvent) => void;
  children: ReactNode;
}): ReactElement {
  const insets = useSafeAreaInsets();
  if (variant === "popover") {
    return (
      <View style={styles.popover} onLayout={onLayout} testID="background-work-detail">
        {children}
      </View>
    );
  }
  // The page scrolls only when the command is long enough to push the output under its minimum.
  return (
    <ScrollView
      style={styles.fill}
      contentContainerStyle={
        variant === "sheet" ? styles.sheetContent(insets.bottom) : styles.tabContent
      }
      keyboardShouldPersistTaps="handled"
      testID="background-work-detail"
    >
      {children}
    </ScrollView>
  );
}

/** "‹ Background work" on the left when there is somewhere to go back to; actions on the right. */
function DetailHeader({
  onBack,
  children,
}: {
  onBack?: () => void;
  children?: ReactNode;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.header}>
      {onBack ? (
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel={t("message.backgroundWork.detail.back")}
          style={backButtonStyle}
          testID="background-work-detail-back"
        >
          <ThemedChevronLeft size={ICON_SIZE.md} />
          <Text style={styles.backLabel}>{t("message.backgroundWork.title")}</Text>
        </Pressable>
      ) : null}
      <View style={styles.headerActions}>{children}</View>
    </View>
  );
}

function backButtonStyle({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) {
  return [styles.backButton, (hovered || pressed) && styles.backButtonActive];
}

/** Kind · status chip · run time · start time, one 13 px muted line. */
function StatusLine({
  kind,
  kindLabel,
  status,
  startedAt,
  detail,
}: {
  kind: ReturnType<typeof backgroundWorkKind>;
  kindLabel: string;
  status: DetailStatus;
  startedAt: string;
  detail: JAgentDeskAgentBackgroundWorkDetail | null;
}): ReactElement {
  const { t } = useTranslation();
  const started = new Date(startedAt);
  const running = status === "running";
  return (
    <View style={styles.metaRow}>
      <View accessible accessibilityLabel={kindLabel}>
        <BackgroundWorkKindIcon kind={kind} />
      </View>
      <StatusChip status={status} exitCode={detail?.exitCode ?? null} />
      <Text style={styles.meta} numberOfLines={1}>
        {" · "}
        <RunTime startedAt={started} endedAt={running ? null : detail?.endedAt} />
        {" · "}
        {t("message.backgroundWork.detail.startedAt", { time: formatStartTime(started) })}
      </Text>
    </View>
  );
}

/** The app's status chip: the running ring, a success check, a failure cross, a stop square. */
function StatusChip({
  status,
  exitCode,
}: {
  status: DetailStatus;
  exitCode: number | null;
}): ReactElement {
  const { t } = useTranslation();
  const word = t(`message.backgroundWork.detail.statusValue.${status}`);
  const label =
    exitCode === null || status === "running"
      ? word
      : `${word} · ${t("message.backgroundWork.exitCode", { code: exitCode })}`;
  let leading: ReactNode;
  let variant: "muted" | "success" | "error" = "muted";
  if (status === "running") {
    leading = (
      <View style={styles.ring}>
        <StatusRing />
      </View>
    );
  } else if (status === "finished") {
    variant = "success";
    leading = <ThemedSuccessCheck size={ICON_SIZE.xs} />;
  } else if (status === "failed") {
    variant = "error";
    leading = <ThemedFailedX size={ICON_SIZE.xs} />;
  } else {
    leading = <ThemedSquare size={10} />;
  }
  return (
    <View testID="background-work-detail-status">
      <StatusBadge size="xs" variant={variant} leading={leading} label={label} />
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
  if (endedAt === null) return <LiveElapsed startedAt={startedAt} active />;
  const ended = endedAt ? Date.parse(endedAt) : Number.NaN;
  if (!Number.isFinite(ended)) return <Text>—</Text>;
  return <Text>{formatDuration(Math.max(0, ended - startedAt.getTime()))}</Text>;
}

/** "14:30" today, "Nov 26, 14:30" before. */
function formatStartTime(started: Date): string {
  const now = new Date();
  const sameDay = started.toDateString() === now.toDateString();
  return sameDay
    ? started.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : started.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

/** "{{agent}} · {{folder}}": the folder from ~, cut in the middle to fit the line. */
function OwnerLine({
  serverId,
  agentId,
  cwd,
}: {
  serverId: string;
  agentId: string;
  cwd: string | null;
}): ReactElement | null {
  const agentTitle = useSessionStore(
    (store) => store.sessions[serverId]?.agents?.get(agentId)?.title ?? null,
  );
  const [width, setWidth] = useState(0);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setWidth(event.nativeEvent.layout.width);
  }, []);
  if (!agentTitle && !cwd) return null;
  const parts: string[] = [];
  if (agentTitle) parts.push(agentTitle);
  if (cwd) {
    const folder = shortenPath(cwd);
    const budget = Math.floor(width / META_CHAR_WIDTH) - (agentTitle ? agentTitle.length + 3 : 0);
    parts.push(width > 0 ? truncatePathMiddle(folder, Math.max(budget, 16)) : folder);
  }
  return (
    <View onLayout={onLayout}>
      <Text style={styles.meta} numberOfLines={1} selectable testID="background-work-detail-owner">
        {parts.join(" · ")}
      </Text>
    </View>
  );
}

function detailStateText(
  t: ReturnType<typeof useTranslation>["t"],
  state: ReturnType<typeof useBackgroundWorkDetail>["state"],
): string {
  if (state.status === "update-host") return t("message.backgroundWork.detail.updateHost");
  if (state.status === "error") return t("message.backgroundWork.detail.notFound");
  return t("message.backgroundWork.detail.loading");
}

const styles = StyleSheet.create((theme) => {
  const meta = { fontSize: 13, lineHeight: 18, color: theme.colors.foregroundMuted } as const;
  return {
    popover: {
      width: POPOVER_DETAIL_WIDTH,
      maxWidth: "100%",
      padding: theme.spacing[4],
      gap: theme.spacing[3],
    },
    fill: { flex: 1, minHeight: 0 },
    sheetContent: (bottomInset: number) => ({
      flexGrow: 1,
      gap: theme.spacing[3],
      paddingHorizontal: theme.spacing[4],
      paddingTop: theme.spacing[1],
      paddingBottom: bottomInset + theme.spacing[4],
    }),
    tabContent: {
      flexGrow: 1,
      gap: theme.spacing[3],
      padding: theme.spacing[4],
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
      minHeight: 32,
    },
    headerActions: {
      marginLeft: "auto",
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
    },
    backButton: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[1],
      height: 28,
      paddingLeft: theme.spacing[1],
      paddingRight: theme.spacing[2],
      marginLeft: -theme.spacing[1],
      borderRadius: theme.borderRadius.md,
    },
    backButtonActive: { backgroundColor: theme.colors.surface2 },
    backLabel: {
      fontSize: theme.fontSize.sm,
      fontWeight: theme.fontWeight.medium,
      color: theme.colors.foreground,
    },
    summary: { gap: theme.spacing[1] },
    title: {
      fontSize: theme.fontSize.base,
      lineHeight: 22,
      fontWeight: theme.fontWeight.medium,
      color: theme.colors.foreground,
    },
    metaRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[1.5],
      minWidth: 0,
    },
    meta: { ...meta, flexShrink: 1, minWidth: 0 },
    // Trims the ring's knockout halo, as the composer pill does, so the chip's mark is the ring.
    ring: { margin: -STATUS_RING_HALO_INSET },
    stateText: { ...meta },
  };
});
