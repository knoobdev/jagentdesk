// Hand to bot… (spec 37.4.11). Ported from Orca dfdb4fda (MIT) src/renderer/src/components/bots/
// hand-to-bot/HandToBotFlow.tsx:61-341: pick a bot (or "New bot…") for a workspace and, optionally,
// say what it should do with it. The daemon moves the workspace under the bot and keeps its agents
// running as the bot's workers (`bots.hand_over`); "New bot…" opens New bot, whose Create hands over.
import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { ChevronRight, Plus } from "lucide-react-native";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import { AdaptiveModalSheet, type SheetKeyboard } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { BotAvatar } from "@/bots/avatar";
import { openBot } from "@/bots/navigation";
import { botErrorMessage, useBots, useBotsMutation } from "@/bots/queries";

const ThemedPlus = withUnistyles(Plus);
const ThemedChevronRight = withUnistyles(ChevronRight);
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
/** `shared/bots/bot-take-over.ts` BOT_TAKE_OVER_GOAL_MAX. */
const GOAL_MAX = 4000;

/** The workspace's own agents that are working: not subagents, not archived, not closed. */
export function countWorkspaceAgents(
  agents: Iterable<{
    workspaceId?: string;
    parentAgentId: string | null;
    archivedAt?: Date | null;
    status: string;
  }>,
  workspaceId: string,
): number {
  let count = 0;
  for (const agent of agents) {
    if (agent.workspaceId !== workspaceId || agent.parentAgentId || agent.archivedAt) continue;
    if (agent.status === "closed") continue;
    count += 1;
  }
  return count;
}

export function HandToBotFlow({
  serverId,
  workspaceId,
  name,
  onClose,
  onNewBot,
}: {
  serverId: string;
  workspaceId: string;
  name: string;
  onClose: () => void;
  /** "New bot…": New bot, made for this workspace, with the goal typed so far. */
  onNewBot: (goal: string) => void;
}) {
  const { t } = useTranslation();
  const bots = useBots(serverId);
  const [picked, setPicked] = useState<string | null>(null);
  const [goal, setGoal] = useState("");
  const handOver = useBotsMutation(serverId, "bots.hand_over.request");
  const agentCount = useSessionStore(
    useShallow((state) => {
      const agents = state.sessions[serverId]?.agents;
      return agents ? countWorkspaceAgents(agents.values(), workspaceId) : 0;
    }),
  );
  const list = bots.data ?? [];
  const owner =
    list.find((bot) => bot.handedWorkspaces?.some((entry) => entry.workspaceId === workspaceId)) ??
    null;
  const pickedBot = list.find((bot) => bot.id === picked) ?? null;
  let description: string;
  if (agentCount === 0) description = t("bots.handToBot.noAgents");
  else if (agentCount === 1) description = t("bots.handToBot.oneAgent");
  else description = t("bots.handToBot.agents", { n: agentCount });
  const header = useMemo(
    () => ({ title: t("bots.handToBot.title", { name }), subtitle: description }),
    [description, name, t],
  );
  const submit = useCallback(async () => {
    if (!pickedBot || handOver.isPending) return;
    const trimmed = goal.trim();
    try {
      const result = await handOver.mutateAsync({
        workspaceId,
        botId: pickedBot.id,
        ...(trimmed ? { goal: trimmed } : {}),
      });
      onClose();
      openBot(serverId, result.bot.id, { tab: "home" });
    } catch {
      // The mutation keeps the error; the dialog shows it under the form.
    }
  }, [goal, handOver, onClose, pickedBot, serverId, workspaceId]);
  const press = useCallback(() => void submit(), [submit]);
  const newBot = useCallback(() => onNewBot(goal.trim()), [goal, onNewBot]);
  const keyboard = useMemo<SheetKeyboard>(
    () => ({
      keys: ["Enter"],
      onKeyDown: (event) => {
        if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return false;
        void submit();
        return true;
      },
    }),
    [submit],
  );
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button
          variant="default"
          size="sm"
          onPress={press}
          disabled={!pickedBot || handOver.isPending}
          loading={handOver.isPending}
          testID="hand-to-bot-submit"
        >
          {owner && pickedBot
            ? t("bots.handToBot.moveTo", { bot: pickedBot.name })
            : t("bots.handToBot.handOver")}
        </Button>
      </View>
    ),
    [handOver.isPending, owner, pickedBot, press, t],
  );
  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      onDismiss={onClose}
      header={header}
      footer={footer}
      desktopMaxWidth={448}
      keyboard={keyboard}
      testID="hand-to-bot-dialog"
    >
      <View style={styles.body}>
        <ScrollView style={styles.rows} contentContainerStyle={styles.rowsContent}>
          <Pressable
            onPress={newBot}
            accessibilityRole="button"
            style={styles.row}
            testID="hand-to-bot-new"
          >
            <View style={styles.newTile}>
              <ThemedPlus size={14} uniProps={muted} />
            </View>
            <View style={styles.rowText}>
              <Text style={styles.name}>{t("bots.handToBot.newBot")}</Text>
              <Text style={styles.detail} numberOfLines={1}>
                {t("bots.handToBot.newBotNote")}
              </Text>
            </View>
            <ThemedChevronRight size={16} uniProps={muted} />
          </Pressable>
          <View accessibilityRole="radiogroup" accessibilityLabel={t("bots.handToBot.pick")}>
            {list.map((bot) => (
              <BotPickRow
                key={bot.id}
                serverId={serverId}
                bot={bot}
                selected={bot.id === picked}
                hasIt={owner?.id === bot.id}
                onPick={setPicked}
              />
            ))}
          </View>
        </ScrollView>
        <Field label={`${t("bots.handToBot.goal")} ${t("bots.handToBot.optional")}`}>
          <FormTextInput
            value={goal}
            initialValue={goal}
            webControlled
            onChangeText={setGoal}
            maxLength={GOAL_MAX}
            placeholder={t("bots.handToBot.goalPlaceholder")}
            accessibilityLabel={t("bots.handToBot.goal")}
            size="sm"
            testID="hand-to-bot-goal"
          />
        </Field>
        {owner && pickedBot ? (
          <View style={styles.note}>
            <BotAvatar bot={owner} serverId={serverId} size={16} />
            <Text style={styles.detail}>
              {t("bots.handToBot.moveNote", { owner: owner.name, bot: pickedBot.name })}
            </Text>
          </View>
        ) : null}
        {handOver.error ? (
          <Text style={styles.error} accessibilityRole="alert">
            {botErrorMessage(handOver.error)}
          </Text>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

function BotPickRow({
  serverId,
  bot,
  selected,
  hasIt,
  onPick,
}: {
  serverId: string;
  bot: Bot;
  selected: boolean;
  hasIt: boolean;
  onPick: (id: string) => void;
}) {
  const { t } = useTranslation();
  const pick = useCallback(() => onPick(bot.id), [bot.id, onPick]);
  return (
    <Pressable
      onPress={pick}
      disabled={hasIt}
      accessibilityRole="radio"
      aria-checked={selected}
      aria-disabled={hasIt}
      style={[styles.row, selected && styles.rowSelected]}
      testID={`hand-to-bot-pick-${bot.id}`}
    >
      <BotAvatar bot={bot} serverId={serverId} size={28} radius={8} />
      <View style={styles.rowText}>
        <Text style={styles.name} numberOfLines={1}>
          {bot.name}
        </Text>
        <Text style={styles.detail} numberOfLines={1}>
          {bot.identity}
        </Text>
      </View>
      {hasIt ? <Text style={styles.detail}>{t("bots.handToBot.hasIt")}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  body: { gap: 16 },
  rows: { maxHeight: 280 },
  rowsContent: { gap: 2 },
  row: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 8,
  },
  rowSelected: { backgroundColor: theme.chrome.selectedRow },
  newTile: {
    width: 28,
    height: 28,
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  rowText: { flex: 1, minWidth: 0 },
  name: { fontSize: 14, fontWeight: "500", color: theme.colors.foreground },
  detail: { flexShrink: 1, fontSize: 12, color: theme.colors.foregroundMuted },
  note: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  error: { fontSize: 12, color: theme.colors.statusDanger },
  footer: { flexDirection: "row", justifyContent: "flex-end" },
}));
