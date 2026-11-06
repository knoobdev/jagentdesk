import { useCallback, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { Text, View, Pressable, ScrollView } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { LiveElapsed } from "@/components/message";
import { Button } from "@/components/ui/button";
import type { JAgentDeskAgentBackgroundWorkItem } from "@jagentdesk/client";
import { createHostBackgroundWorkModel } from "./host";
import { backgroundWorkText } from "./presentation";
export { createHostBackgroundWorkModel } from "./host";

function kindKey(kind: string): "shell" | "monitor" | "other" {
  if (kind === "shell" || kind === "monitor") return kind;
  return "other";
}

export function BackgroundWorkTrack({
  model,
  count,
}: {
  model: ReturnType<typeof createHostBackgroundWorkModel>;
  count: number;
}) {
  const { t } = useTranslation();
  const { items, status, stops } = useSyncExternalStore(
    model.subscribe,
    model.getSnapshot,
    model.getSnapshot,
  );
  const missing = Object.values(stops ?? {}).filter(
    (entry) => !items?.some((item) => item.stopToken === entry.item.stopToken),
  );
  const rows = [...(items ?? []), ...missing.map((entry) => entry.item)];
  if (count === 0 && rows.length === 0) return null;
  const visibleCount = items?.length || count;
  return (
    <BackgroundWorkSurface
      testID="background-work"
      panelTitle={t("message.backgroundWork.title")}
      segments={[
        {
          bucket: "running",
          text:
            visibleCount === 1
              ? t("message.backgroundWork.pillOne")
              : t("message.backgroundWork.pillMany", { count: visibleCount }),
        },
      ]}
    >
      {status === "loading" || status === "stale" ? (
        <BackgroundWorkDetailRow>
          <Text style={styles.facts}>{t("message.backgroundWork.waiting")}</Text>
        </BackgroundWorkDetailRow>
      ) : null}
      {status === "error" ? (
        <>
          <BackgroundWorkDetailRow>
            <Text style={styles.facts}>{t("message.backgroundWork.error")}</Text>
          </BackgroundWorkDetailRow>
          <BackgroundWorkDetailRow
            onPress={model.retry}
            closeOnSelect={false}
            accessibilityLabel={t("message.backgroundWork.retry")}
          >
            <Text style={styles.title}>{t("message.backgroundWork.retry")}</Text>
          </BackgroundWorkDetailRow>
        </>
      ) : null}
      {rows.map((item) => (
        <BackgroundWorkRow
          key={item.stopToken ?? item.id}
          item={item}
          model={model}
          live={Boolean(items?.some((entry) => entry.stopToken === item.stopToken))}
          ready={status === "ready"}
          stopStatus={stops?.[item.stopToken ?? ""]?.status}
        />
      ))}
    </BackgroundWorkSurface>
  );
}

function BackgroundWorkRow({
  item,
  model,
  live,
  ready,
  stopStatus,
}: {
  item: JAgentDeskAgentBackgroundWorkItem;
  model: ReturnType<typeof createHostBackgroundWorkModel>;
  live: boolean;
  ready: boolean;
  stopStatus?: "pending" | "error";
}) {
  const { t } = useTranslation();
  const kind = t(`message.backgroundWork.${kindKey(item.kind)}`);
  const stop = useCallback(() => {
    void model.stopItem(item);
  }, [model, item]);
  const dismiss = useCallback(
    () => model.dismissStop(item.stopToken ?? ""),
    [model, item.stopToken],
  );
  let detail = t("message.backgroundWork.notRunning");
  if (stopStatus === "pending") detail = t("message.backgroundWork.stopping");
  const { title, command } = backgroundWorkText(item, kind);
  const action = item.canStop && ready && live;
  const label =
    stopStatus === "pending"
      ? t("message.backgroundWork.stopping")
      : t("message.backgroundWork.stop");
  return (
    <BackgroundWorkDetailRow>
      <View style={styles.row}>
        <Text style={styles.title}>{title}</Text>
        {command ? <Text style={styles.facts}>{command}</Text> : null}
        <Text style={styles.facts}>
          {kind} ·{" "}
          {live ? (
            <LiveElapsed startedAt={new Date(item.startedAt)} active style={styles.facts} />
          ) : (
            detail
          )}
        </Text>
        {stopStatus === "error" ? (
          <Text style={styles.facts}>{t("message.backgroundWork.stopError")}</Text>
        ) : null}
      </View>
      {action ? (
        <Button
          variant="ghost"
          size="sm"
          accessibilityLabel={`${t("message.backgroundWork.stop")} ${title}`}
          disabled={stopStatus === "pending"}
          onPress={stop}
        >
          {label}
        </Button>
      ) : null}
      {!live && stopStatus === "error" ? (
        <Button variant="ghost" size="sm" onPress={dismiss}>
          {t("message.backgroundWork.dismiss")}
        </Button>
      ) : null}
    </BackgroundWorkDetailRow>
  );
}

const styles = StyleSheet.create((theme) => ({
  surface: {
    marginHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  header: { padding: theme.spacing[2] },
  details: { maxHeight: 240 },
  detailRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[2],
  },
  row: { flexGrow: 1, flexShrink: 1, flexBasis: "auto", minWidth: 0 },
  title: { fontSize: theme.fontSize.base, color: theme.colors.foreground },
  facts: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
}));

// This checkout uses composer cards; keep the existing SubagentsTrack header/detail layout.
function BackgroundWorkSurface({
  testID,
  panelTitle,
  segments,
  children,
}: {
  testID: string;
  panelTitle: string;
  segments: Array<{ bucket: string; text: string }>;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);
  const label = segments.map((segment) => segment.text).join(" · ");
  return (
    <View style={styles.surface} testID={testID}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={panelTitle}
        accessibilityState={accessibilityState}
        onPress={toggleExpanded}
        style={styles.header}
      >
        <Text style={styles.title}>{label}</Text>
      </Pressable>
      {expanded ? (
        <ScrollView style={styles.details} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      ) : null}
    </View>
  );
}

function BackgroundWorkDetailRow({
  children,
  onPress,
  accessibilityLabel,
}: {
  children: ReactNode;
  onPress?: () => void;
  closeOnSelect?: boolean;
  accessibilityLabel?: string;
}) {
  if (onPress)
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        onPress={onPress}
        style={styles.detailRow}
      >
        {children}
      </Pressable>
    );
  return <View style={styles.detailRow}>{children}</View>;
}
