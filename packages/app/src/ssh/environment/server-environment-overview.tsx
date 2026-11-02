import { RefreshCw } from "lucide-react-native";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ServerEnvironment } from "@jagentdesk/protocol/ssh/environment-schemas";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import {
  buildEnvironmentCards,
  type EnvironmentCard,
  type EnvironmentRow,
} from "./environment-cards";
import type { ServerEnvironmentView } from "./use-server-environment";

export interface ServerEnvironmentOverviewProps {
  view: ServerEnvironmentView;
  onRedetect: () => void;
}

function shownEnvironment(view: ServerEnvironmentView): ServerEnvironment | null {
  if (view.kind === "ready") return view.environment;
  return view.previous;
}

/**
 * The environment block at the top of a server's screen (spec 25.13): OS, resources, installed
 * software and services as cards, with "Re-detect". Cards wrap into a grid on desktop and stack
 * full-width on compact (mobile) layouts.
 */
export function ServerEnvironmentOverview({ view, onRedetect }: ServerEnvironmentOverviewProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const environment = shownEnvironment(view);
  const cards = useMemo(
    () => (environment ? buildEnvironmentCards(environment) : []),
    [environment],
  );
  const isDetecting = view.kind === "detecting";
  const detectedAt = environment ? new Date(environment.detectedAtMs).toLocaleString() : null;

  return (
    <View style={styles.container} testID="ssh-environment-overview">
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title}>{t("ssh.environment.title")}</Text>
          <Text style={styles.subtitle}>
            {detectedAt
              ? t("ssh.environment.detectedAt", { time: detectedAt })
              : t("ssh.environment.notDetected")}
          </Text>
        </View>
        <Button
          variant="outline"
          size="sm"
          leftIcon={RefreshCw}
          loading={isDetecting}
          disabled={isDetecting}
          onPress={onRedetect}
          testID="ssh-environment-redetect"
        >
          {isDetecting ? t("ssh.environment.detecting") : t("ssh.environment.redetect")}
        </Button>
      </View>
      {view.kind === "failed" ? (
        <Alert
          variant="error"
          title={t("ssh.environment.failedTitle")}
          description={view.message}
          testID="ssh-environment-error"
        />
      ) : null}
      <View style={isCompact ? styles.stack : styles.grid}>
        {cards.map((card) => (
          <EnvironmentCardView key={card.id} card={card} isCompact={isCompact} />
        ))}
      </View>
    </View>
  );
}

function EnvironmentCardView({ card, isCompact }: { card: EnvironmentCard; isCompact: boolean }) {
  const { t } = useTranslation();
  return (
    <View
      style={isCompact ? styles.cardCompact : styles.card}
      testID={`ssh-environment-card-${card.id}`}
    >
      <Text style={styles.cardTitle}>{t(`ssh.environment.cards.${card.id}`)}</Text>
      {card.rows.map((entry) => (
        <EnvironmentRowView key={entry.labelKey ?? entry.label ?? entry.value} entry={entry} />
      ))}
    </View>
  );
}

function EnvironmentRowView({ entry }: { entry: EnvironmentRow }) {
  const { t } = useTranslation();
  const label = entry.labelKey ? t(`ssh.environment.rows.${entry.labelKey}`) : entry.label;
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text
        style={entry.tone === "warning" ? styles.rowValueWarning : styles.rowValue}
        numberOfLines={2}
        selectable
      >
        {entry.value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: { gap: theme.spacing[3] },
  header: { flexDirection: "row", alignItems: "center", gap: theme.spacing[3] },
  headerText: { flex: 1, gap: theme.spacing[1] },
  title: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  subtitle: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[3] },
  stack: { gap: theme.spacing[3] },
  card: {
    flexGrow: 1,
    flexBasis: 260,
    minWidth: 240,
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  cardCompact: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  cardTitle: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase",
  },
  row: { flexDirection: "row", alignItems: "flex-start", gap: theme.spacing[3] },
  rowLabel: { width: 112, fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  rowValue: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
  },
  rowValueWarning: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.palette.amber[500],
    fontFamily: theme.fontFamily.mono,
  },
}));
