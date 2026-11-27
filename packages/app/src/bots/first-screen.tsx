// A new bot's Home while its first turn runs (spec 37.4.2, `firstRun=true`): who it is, its two setup
// steps, and what it finds as it reads the host. Ported from Orca dfdb4fda (MIT)
// src/renderer/src/components/bots/BotFirstScreen.tsx:1-266 (layout, steps, Try again) and
// src/shared/bots/bot-first-look-words.ts (the rows); the scan is `bots.first_screen.scan`.
import { useCallback, useMemo } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Check, RotateCcw, X } from "lucide-react-native";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import { Button } from "@/components/ui/button";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useBotsRead } from "@/bots/queries";
import { BotAvatar } from "@/bots/avatar";
import { firstLookRows } from "./panel/first-look-words";

const ThemedCheck = withUnistyles(Check);
const ThemedX = withUnistyles(X);
const ThemedSpinner = withUnistyles(ActivityIndicator);
const faint = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});
const danger = (theme: { colors: { statusDanger: string } }) => ({
  color: theme.colors.statusDanger,
});

type StepState = "done" | "running" | "failed";

function StepMark({ state }: { state: StepState }) {
  if (state === "done") return <ThemedCheck size={14} uniProps={faint} />;
  if (state === "failed") return <ThemedX size={14} uniProps={danger} />;
  return <ThemedSpinner size="small" uniProps={faint} />;
}

/** The provider's name as the host lists it ("Claude Code"), else its id. */
function useAgentLabel(serverId: string, provider: string): string {
  const providers = useProvidersSnapshot(serverId);
  return useMemo(
    () => providers.entries?.find((entry) => entry.provider === provider)?.label ?? provider,
    [providers.entries, provider],
  );
}

export function BotFirstScreen({ serverId, bot }: { serverId: string; bot: Bot }) {
  const { t } = useTranslation();
  const scan = useBotsRead(serverId, "bots.first_screen.scan.request", { botId: bot.id });
  const agent = useAgentLabel(serverId, bot.provider);
  const failed = scan.isError;
  const rows = firstLookRows(scan.data?.scan, t);
  const reading = !scan.isSuccess && !failed;
  const tryAgain = useCallback(() => void scan.refetch(), [scan]);
  const steps: { id: string; state: StepState; label: string }[] = [
    { id: "create", state: "done", label: t("bots.firstScreen.stepCreate") },
    {
      id: "reply",
      state: failed ? "failed" : "running",
      label: t("bots.firstScreen.stepReply"),
    },
  ];
  return (
    <ScrollView contentContainerStyle={styles.screen} testID="bot-first-screen">
      <BotAvatar bot={bot} serverId={serverId} size={80} radius={16} />
      <Text style={styles.name}>{bot.name}</Text>
      <Text style={styles.subtitle}>{t("bots.firstScreen.subtitle", { agent })}</Text>
      <View style={styles.card}>
        {steps.map((step) => (
          <View key={step.id} style={styles.step}>
            <View style={styles.mark}>
              <StepMark state={step.state} />
            </View>
            <Text style={[styles.stepLabel, step.state === "failed" && styles.failed]}>
              {step.label}
            </Text>
          </View>
        ))}
        {failed ? (
          <View style={styles.tryAgain}>
            <Text style={styles.tryAgainText}>{t("bots.firstScreen.failed")}</Text>
            <Button size="xs" variant="outline" leftIcon={RotateCcw} onPress={tryAgain}>
              {t("bots.firstScreen.tryAgain")}
            </Button>
          </View>
        ) : null}
      </View>
      {failed ? null : (
        <View style={styles.rows}>
          <Text style={styles.readingTitle}>
            {reading ? t("bots.firstScreen.reading") : t("bots.firstScreen.read")}
          </Text>
          {rows.map((row) => (
            <View key={row.area} style={styles.step} testID={`bot-first-look-${row.area}`}>
              <View style={styles.mark}>
                <StepMark state={row.done ? "done" : "running"} />
              </View>
              <Text style={styles.rowText} numberOfLines={1}>
                {row.text}
              </Text>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
    paddingBottom: 40,
  },
  name: { paddingTop: 16, fontSize: 20, fontWeight: "600", color: theme.colors.foreground },
  subtitle: { paddingTop: 4, fontSize: 14, color: theme.colors.foregroundMuted },
  card: {
    marginTop: 24,
    width: 384,
    maxWidth: "100%",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  step: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 },
  mark: { width: 16, height: 16, alignItems: "center", justifyContent: "center" },
  stepLabel: { flex: 1, fontSize: 14, color: theme.colors.foreground },
  failed: { color: theme.colors.statusDanger },
  tryAgain: {
    marginTop: 4,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  tryAgainText: { flex: 1, fontSize: 12, color: theme.colors.foregroundMuted },
  rows: { width: 384, maxWidth: "100%", gap: 8, paddingTop: 24 },
  readingTitle: { fontSize: 12, color: theme.colors.foregroundMuted },
  rowText: { flex: 1, minWidth: 0, fontSize: 14, color: theme.colors.foreground },
}));
