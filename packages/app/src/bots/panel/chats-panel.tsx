// A bot page's Chats tab (spec 37.4.6): search and New chat on top, then Home Chat and every other
// chat as one folded row, its workers behind a chevron. Ported from Orca dfdb4fda (MIT)
// src/renderer/src/components/bots/BotChatsPanel.tsx:80-261, BotChatTreeGroup.tsx:60-373,
// BotChatTreeWorkerRow.tsx:50-217 and BotNewChatMenuItems.tsx:40-70; the search runs on the daemon
// (`bots.chats.tree {query}`), not on a local index.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Plus } from "lucide-react-native";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import type { BotChat, BotChatWorker } from "@jagentdesk/protocol/bots/views";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { confirmNewHomeChat } from "../settings/home-chat-confirm";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { botErrorMessage, useBotsMutation, useChatTree } from "@/bots/queries";
import { useBotPanelStore } from "@/bots/panel-store";
import { BotPanelNote } from "./panel-section";
import { BotWorkerDot } from "./worker-dot";
import {
  botChatKindKey,
  chatWorkersShown,
  orderChatWorkers,
  orderChatsTab,
} from "./chat-tree-view";

const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedChevronDown = withUnistyles(ChevronDown);
const muted = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});

/** The query the daemon searches, a moment after typing stops. */
function useSettledQuery(query: string): string {
  const [settled, setSettled] = useState(query);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  return settled;
}

function openBotChat(serverId: string, bot: Bot, chat: BotChat) {
  if (chat.kind === "home") {
    // The bot page's centre is the Home Chat; closing an opened file brings it back.
    useBotPanelStore.getState().setOpenFile(bot.id, null);
    return;
  }
  navigateToAgent({ serverId, agentId: chat.id });
}

function WorkerRow({
  serverId,
  bot,
  worker,
}: {
  serverId: string;
  bot: Bot;
  worker: BotChatWorker;
}) {
  const { t } = useTranslation();
  const open = useCallback(
    () => navigateToAgent({ serverId, agentId: worker.agentId }),
    [serverId, worker.agentId],
  );
  return (
    <Pressable
      onPress={open}
      accessibilityRole="button"
      accessibilityLabel={worker.title}
      style={styles.workerRow}
      testID={`bot-chats-worker-${worker.agentId}`}
    >
      <BotWorkerDot state={worker.state} />
      <Text style={styles.workerTitle} numberOfLines={1}>
        {worker.title}
      </Text>
      {worker.state === "needs-you" ? (
        <Text style={styles.asking} numberOfLines={1}>
          {t("bots.chats.askingBot", { name: bot.name })}
        </Text>
      ) : null}
    </Pressable>
  );
}

function ChatLine({ chat, folded }: { chat: BotChat; folded: boolean }) {
  const { t } = useTranslation();
  const kind = t(botChatKindKey(chat.kind));
  let live: string | null = null;
  if (chat.live === "replying") live = t("bots.chats.replying");
  else if (chat.live === "needs-you") live = t("bots.chats.waiting");
  const counts: string[] = [];
  if (folded && chat.waitingTotal > 0)
    counts.push(t("bots.chats.waitingCount", { count: chat.waitingTotal }));
  if (folded && chat.runningTotal > 0)
    counts.push(t("bots.chats.runningCount", { count: chat.runningTotal }));
  return (
    <Text style={styles.chatLine} numberOfLines={1}>
      {[chat.kind === "home" ? null : kind, live, ...counts].filter(Boolean).join(" · ") || kind}
    </Text>
  );
}

function ChatGroup({
  serverId,
  bot,
  chat,
  searching,
}: {
  serverId: string;
  bot: Bot;
  chat: BotChat;
  searching: boolean;
}) {
  const { t } = useTranslation();
  // The panel's own folds: every chat starts folded here; a search shows what it found.
  const [unfolded, setUnfolded] = useState(false);
  const [steps, setSteps] = useState(0);
  const open = searching || unfolded;
  const workers = useMemo(() => orderChatWorkers(chat.workers), [chat.workers]);
  const { shown, hidden, next } = chatWorkersShown(workers.length, steps);
  const title =
    chat.kind === "home" ? t("bots.chats.home") : chat.title || t("bots.chats.untitled");
  const press = useCallback(() => openBotChat(serverId, bot, chat), [serverId, bot, chat]);
  const toggle = useCallback(() => setUnfolded((value) => !value), []);
  const more = useCallback(() => setSteps((value) => value + 1), []);
  const fewer = useCallback(() => setSteps(0), []);
  const Chevron = open ? ThemedChevronDown : ThemedChevronRight;
  const expanded = useMemo(() => ({ expanded: open }), [open]);
  let paging: ReactNode = null;
  if (hidden > 0)
    paging = (
      <Pressable onPress={more} accessibilityRole="button" style={styles.moreRow}>
        <Text style={styles.moreText}>
          {next === 8
            ? t("bots.chats.showEightMoreWorkers")
            : t("bots.chats.showMoreWorkers", { count: next })}
        </Text>
      </Pressable>
    );
  else if (steps > 0)
    paging = (
      <Pressable onPress={fewer} accessibilityRole="button" style={styles.moreRow}>
        <Text style={styles.moreText}>{t("bots.chats.showFewer")}</Text>
      </Pressable>
    );
  return (
    <View testID={`bot-chats-chat-${chat.id}`}>
      <View style={styles.chatRow}>
        {workers.length > 0 ? (
          <Pressable
            onPress={toggle}
            accessibilityRole="button"
            accessibilityLabel={
              open ? t("bots.chats.fold", { name: title }) : t("bots.chats.unfold", { name: title })
            }
            accessibilityState={expanded}
            style={styles.fold}
          >
            <Chevron size={14} uniProps={muted} />
          </Pressable>
        ) : (
          <View style={styles.fold} />
        )}
        <Pressable
          onPress={press}
          accessibilityRole="button"
          accessibilityLabel={title}
          style={styles.chatMain}
        >
          <Text style={styles.chatTitle} numberOfLines={1}>
            {title}
          </Text>
          <ChatLine chat={chat} folded={!open} />
        </Pressable>
      </View>
      {open ? (
        <View style={styles.workers}>
          {workers.slice(0, shown).map((worker) => (
            <WorkerRow key={worker.agentId} serverId={serverId} bot={bot} worker={worker} />
          ))}
          {paging}
        </View>
      ) : null}
    </View>
  );
}

/** "New chat": a fresh Home Chat (spec 37.3.5); the bot keeps its soul and memory. */
function NewChatMenu({ serverId, bot }: { serverId: string; bot: Bot }) {
  const { t } = useTranslation();
  const reset = useBotsMutation(serverId, "bots.chat.reset.request");
  const [error, setError] = useState<string | null>(null);
  const newHomeChat = useCallback(async () => {
    // Asks first unless Settings › Plugins › Bots turned "Ask before a new Home Chat" off.
    if (!(await confirmNewHomeChat(bot))) return;
    setError(null);
    reset.mutate({ botId: bot.id }, { onError: (caught) => setError(botErrorMessage(caught)) });
  }, [bot, reset]);
  return (
    <View>
      <DropdownMenu>
        <DropdownMenuTrigger
          style={styles.newChat}
          accessibilityLabel={t("bots.chats.new")}
          testID="bot-chats-new"
        >
          <ThemedPlusIcon />
          <Text style={styles.newChatText}>{t("bots.chats.new")}</Text>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" width={240}>
          <DropdownMenuItem onSelect={newHomeChat} description={t("bots.newHomeChat.hint")}>
            {t("bots.newHomeChat.action")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const ThemedPlus = withUnistyles(Plus);
const foreground = (theme: { colors: { foreground: string } }) => ({
  color: theme.colors.foreground,
});
function ThemedPlusIcon() {
  return <ThemedPlus size={14} uniProps={foreground} />;
}

export function BotChatsPanel({ serverId, bot }: { serverId: string; bot: Bot }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const settled = useSettledQuery(query);
  const tree = useChatTree(serverId, bot.id, settled || undefined);
  const chats = useMemo(() => orderChatsTab(tree.data), [tree.data]);
  const searching = settled !== "";
  const retry = useCallback(() => void tree.refetch(), [tree]);
  const onlyHome = !searching && tree.isSuccess && chats.every((chat) => chat.kind === "home");
  return (
    <ScrollView contentContainerStyle={styles.panel} testID="bot-chats-panel">
      <View style={styles.toolbar}>
        <View style={styles.search}>
          <SearchField
            value={query}
            onChangeText={setQuery}
            placeholder={t("bots.chats.search")}
            clearAccessibilityLabel={t("bots.connectors.clearSearch")}
            testID="bot-chats-search"
          />
        </View>
        <NewChatMenu serverId={serverId} bot={bot} />
      </View>
      {tree.isPending ? <BotPanelNote>{t("bots.chats.loading")}</BotPanelNote> : null}
      {tree.isError ? (
        <View style={styles.readFailed}>
          <BotPanelNote>{t("bots.chats.readFailed")}</BotPanelNote>
          <Button size="xs" variant="ghost" onPress={retry}>
            {t("bots.chats.searchRetry")}
          </Button>
        </View>
      ) : null}
      {chats.map((chat) => (
        <ChatGroup key={chat.id} serverId={serverId} bot={bot} chat={chat} searching={searching} />
      ))}
      {searching && tree.isSuccess && chats.length === 0 ? (
        <BotPanelNote testID="bot-chats-no-match">{t("bots.chats.noMatch")}</BotPanelNote>
      ) : null}
      {onlyHome ? (
        <BotPanelNote testID="bot-chats-empty">{t("bots.jad.panels.chats.empty")}</BotPanelNote>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  panel: { paddingHorizontal: 16, paddingVertical: 12, gap: 2 },
  toolbar: { flexDirection: "row", alignItems: "center", gap: 8, paddingBottom: 8 },
  search: { flex: 1, minWidth: 0 },
  newChat: {
    height: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  newChatText: { fontSize: 14, fontWeight: "500", color: theme.colors.foreground },
  readFailed: { flexDirection: "row", alignItems: "center", gap: 4 },
  chatRow: { minHeight: 44, flexDirection: "row", alignItems: "center", borderRadius: 8 },
  fold: { width: 24, height: 32, alignItems: "center", justifyContent: "center" },
  chatMain: { flex: 1, minWidth: 0, paddingVertical: 4, paddingRight: 8 },
  chatTitle: { fontSize: 14, fontWeight: "500", color: theme.colors.foreground },
  chatLine: { fontSize: 12, color: theme.colors.foregroundMuted },
  workers: { paddingLeft: 24 },
  workerRow: {
    height: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingLeft: 16,
    paddingRight: 8,
    borderRadius: 8,
  },
  workerTitle: { flex: 1, minWidth: 0, fontSize: 14, color: theme.colors.foreground },
  asking: { fontSize: 12, color: theme.colors.statusWarning },
  moreRow: { height: 28, justifyContent: "center", paddingLeft: 16 },
  moreText: { fontSize: 12, color: theme.colors.foregroundMuted },
  error: { fontSize: 12, color: theme.colors.statusDanger, paddingTop: 4 },
}));
