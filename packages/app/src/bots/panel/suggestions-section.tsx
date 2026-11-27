// Suggestions in the bot's Home panel (spec 37.4.4 item 5): what the last Look around found, with
// "Look now", and Start / Dismiss on each. Ported from Orca dfdb4fda (MIT)
// src/renderer/src/components/bots/BotUpNextSection.tsx:20-339 and bot-up-next-actions.ts:1-57.
// Shown only for Claude and Codex bots with Look around on (`bot-look-around.ts:10`).
import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import type { BotSuggestion } from "@jagentdesk/protocol/bots/views";
import { botLookAround, lookAroundSupported } from "@jagentdesk/protocol/bots/rules";
import { Button } from "@/components/ui/button";
import { botErrorCode, botErrorMessage, useBotsMutation, useBotsRead } from "@/bots/queries";
import { BotPanelNote, BotPanelSection } from "./panel-section";
import { lookedText } from "./automation-rows";

/** "Look now"'s refusals, as Orca words them (`bot-up-next-actions.ts`). */
export function lookNowErrorKey(code: string | null): string {
  if (code === "already_running") return "bots.upNext.lookNowRunning";
  if (code === "paused") return "bots.upNext.lookNowPaused";
  return "bots.upNext.lookNowFailed";
}

function SuggestionRow({
  serverId,
  bot,
  suggestion,
}: {
  serverId: string;
  bot: Bot;
  suggestion: BotSuggestion;
}) {
  const { t } = useTranslation();
  const start = useBotsMutation(serverId, "bots.suggestions.start.request");
  const dismiss = useBotsMutation(serverId, "bots.suggestions.dismiss.request");
  const [error, setError] = useState<string | null>(null);
  const pressStart = useCallback(() => {
    setError(null);
    start.mutate(
      { botId: bot.id, suggestionId: suggestion.id },
      {
        onError: (caught) =>
          setError(
            botErrorCode(caught) === "not_found"
              ? t("bots.upNext.startFailed")
              : botErrorMessage(caught),
          ),
      },
    );
  }, [bot.id, start, suggestion.id, t]);
  const pressDismiss = useCallback(() => {
    setError(null);
    dismiss.mutate(
      { botId: bot.id, suggestionId: suggestion.id },
      { onError: (caught) => setError(botErrorMessage(caught)) },
    );
  }, [bot.id, dismiss, suggestion.id]);
  return (
    <View style={styles.suggestion} testID={`bot-suggestion-${suggestion.id}`}>
      <View style={styles.suggestionText}>
        <Text style={styles.title} numberOfLines={2}>
          {suggestion.title}
        </Text>
        {suggestion.why ? (
          <Text style={styles.why} numberOfLines={2}>
            {suggestion.why}
          </Text>
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
      <View style={styles.actions}>
        <Button size="xs" variant="outline" onPress={pressStart} loading={start.isPending}>
          {t("bots.upNext.start")}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onPress={pressDismiss}
          loading={dismiss.isPending}
          accessibilityLabel={t("bots.upNext.dismiss")}
        >
          {t("bots.upNext.dismiss")}
        </Button>
      </View>
    </View>
  );
}

export function BotSuggestionsSection({ serverId, bot }: { serverId: string; bot: Bot }) {
  const { t } = useTranslation();
  const shown = lookAroundSupported(bot.provider) && botLookAround(bot).on;
  const read = useBotsRead(
    serverId,
    "bots.suggestions.list.request",
    { botId: bot.id },
    { enabled: shown },
  );
  const lookNow = useBotsMutation(serverId, "bots.look_around.run_now.request");
  const [error, setError] = useState<string | null>(null);
  const look = useCallback(() => {
    setError(null);
    lookNow.mutate(
      { botId: bot.id },
      { onError: (caught) => setError(t(lookNowErrorKey(botErrorCode(caught)))) },
    );
  }, [bot.id, lookNow, t]);
  const state = read.data?.state;
  const running = Boolean(state?.running) || lookNow.isPending;
  const actions = useMemo(
    () => (
      <Button
        size="xs"
        variant="ghost"
        onPress={look}
        disabled={running}
        testID="bot-suggestions-look-now"
      >
        {running ? t("bots.upNext.lookingShort") : t("bots.upNext.lookNow")}
      </Button>
    ),
    [look, running, t],
  );
  if (!shown) return null;
  const suggestions = read.data?.suggestions ?? [];
  const note = state?.lastLookedAt_ms ? lookedText(t, state.lastLookedAt_ms, Date.now()) : null;
  return (
    <BotPanelSection
      title={t("bots.upNext.title")}
      note={note}
      testID="bot-suggestions"
      actions={actions}
    >
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {state?.turnedOff ? <BotPanelNote>{state.turnedOff}</BotPanelNote> : null}
      {suggestions.map((suggestion) => (
        <SuggestionRow key={suggestion.id} serverId={serverId} bot={bot} suggestion={suggestion} />
      ))}
    </BotPanelSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  suggestion: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  suggestionText: { flex: 1, minWidth: 0, gap: 2 },
  title: { fontSize: 14, color: theme.colors.foreground },
  why: { fontSize: 12, color: theme.colors.foregroundMuted },
  actions: { flexDirection: "row", gap: 4 },
  error: { fontSize: 12, color: theme.colors.statusDanger },
}));
