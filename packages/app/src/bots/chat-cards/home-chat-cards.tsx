// The Home Chat's bot cards (spec 37.4.2, 37.2.6, 37.3.3): the daemon's notes — item changes with
// chips that open the item, Look around / Tidy memory runs, automation runs, waits that ended,
// hand-overs — and the approvals of the bot's workers. Ported from Orca dfdb4fda (MIT)
// src/renderer/src/components/native-chat/bot-items/NativeChatBotItemNoteRow.tsx:1-348 (note row,
// item chips), BotTidyUpLine.tsx and prompts/NativeChatApprovalCard.tsx:180-239.
//
// The agent timeline (AgentStreamView) has no slot for rows from outside its stream, so the cards
// render as a strip the Home Chat places right above its composer: the newest notes, oldest first,
// and the open worker approvals under them.
import { Fragment, useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type { Bot, BotItem, BotMessage } from "@jagentdesk/protocol/bots/types";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { stripBotEnvelope } from "@/bots/envelope";
import { useBotHistory, useChatTree, useItems } from "@/bots/queries";
import { useBotPanelStore } from "@/bots/panel-store";
import { BotWorkerApprovalCard } from "./worker-approval-card";
import { itemNoteKey, itemStatusKey, runNoteText } from "./note-text";

/** Notes the strip keeps; older ones stay in the chat history. */
const NOTES_SHOWN = 4;
const SLOT = "\u0000";

function ItemChip({ botId, item }: { botId: string; item: BotItem }) {
  const { t } = useTranslation();
  const open = useCallback(
    () => useBotPanelStore.getState().openItem(botId, item.id),
    [botId, item.id],
  );
  const label = item.number ? `#${item.number} ${item.title}` : item.title;
  return (
    <Pressable
      onPress={open}
      accessibilityRole="button"
      accessibilityLabel={t("bots.items.chat.chipLabel", {
        title: item.title,
        status: t(itemStatusKey(item.status)),
      })}
      style={styles.chip}
      testID={`bot-note-item-${item.id}`}
    >
      <Text style={styles.chipText} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function ItemNoteRow({
  bot,
  message,
  items,
}: {
  bot: Bot;
  message: BotMessage;
  items: ReadonlyMap<string, BotItem>;
}) {
  const { t } = useTranslation();
  const note = message.note;
  const noted = (note?.itemIds ?? []).flatMap((id) => {
    const item = items.get(id);
    return item ? [item] : [];
  });
  // The sentence with a slot where the chips go ("Moved <chips> to In progress").
  const sentence = t(itemNoteKey(note?.verb), {
    items: SLOT,
    status: note?.status ? t(itemStatusKey(note.status)) : "",
  });
  const [before, after = ""] = sentence.split(SLOT);
  return (
    <View style={styles.note} testID={`bot-note-${message.id}`}>
      <Text style={styles.noteText}>{before}</Text>
      {noted.length > 0 ? (
        noted.map((item, index) => (
          <Fragment key={item.id}>
            {index > 0 ? <Text style={styles.noteText}>,</Text> : null}
            <ItemChip botId={bot.id} item={item} />
          </Fragment>
        ))
      ) : (
        <Text style={styles.noteText}>{stripBotEnvelope(message.text)}</Text>
      )}
      {after ? <Text style={styles.noteText}>{after}</Text> : null}
    </View>
  );
}

function RunNoteRow({ serverId, message }: { serverId: string; message: BotMessage }) {
  const { t } = useTranslation();
  const note = message.note;
  const runAgentId = note?.runAgentId;
  const text = (note && runNoteText(t, note)) ?? stripBotEnvelope(message.text);
  const open = useCallback(() => {
    if (runAgentId) navigateToAgent({ serverId, agentId: runAgentId });
  }, [runAgentId, serverId]);
  return (
    <Pressable
      onPress={open}
      disabled={!runAgentId}
      accessibilityRole={runAgentId ? "button" : undefined}
      style={styles.note}
      testID={`bot-note-${message.id}`}
    >
      {note?.state === "running" ? <View style={styles.runningDot} /> : null}
      <Text style={[styles.noteText, note?.state === "failed" && styles.failed]} numberOfLines={2}>
        {text}
      </Text>
    </Pressable>
  );
}

/** Pending approvals of the bot's workers, from the session store, by worker. */
function useWorkerApprovals(serverId: string, bot: Bot) {
  const tree = useChatTree(serverId, bot.id);
  const workers = useMemo(() => {
    const byId = new Map<string, string>();
    const chats = [...(tree.data?.home ? [tree.data.home] : []), ...(tree.data?.chats ?? [])];
    for (const chat of chats)
      for (const worker of chat.workers) byId.set(worker.agentId, worker.title);
    return byId;
  }, [tree.data]);
  const pending = useSessionStore(
    useShallow((state) =>
      Array.from(state.sessions[serverId]?.pendingPermissions.values() ?? []).filter((permission) =>
        workers.has(permission.agentId),
      ),
    ),
  );
  return { pending, workers };
}

export function BotHomeChatCards({ serverId, bot }: { serverId: string; bot: Bot }) {
  const history = useBotHistory(serverId, bot.id);
  const itemsRead = useItems(serverId, bot.id);
  const client = useHostRuntimeClient(serverId);
  const items = useMemo(
    () => new Map((itemsRead.data ?? []).map((item) => [item.id, item])),
    [itemsRead.data],
  );
  const notes = useMemo(
    () => (history.data ?? []).filter((message) => message.note).slice(-NOTES_SHOWN),
    [history.data],
  );
  const { pending, workers } = useWorkerApprovals(serverId, bot);
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const notNow = useCallback(
    (key: string) => setFolded((current) => new Set([...current, key])),
    [],
  );
  const approvals = pending.filter((permission) => !folded.has(permission.key));
  if (notes.length === 0 && approvals.length === 0) return null;
  return (
    <ScrollView
      style={styles.strip}
      contentContainerStyle={styles.stripContent}
      testID="bot-home-chat-cards"
    >
      {notes.map((message) =>
        message.note?.kind === "item" ? (
          <ItemNoteRow key={message.id} bot={bot} message={message} items={items} />
        ) : (
          <RunNoteRow key={message.id} serverId={serverId} message={message} />
        ),
      )}
      {approvals.map((permission) => (
        <BotWorkerApprovalCard
          key={permission.key}
          serverId={serverId}
          client={client}
          permission={permission}
          workerName={workers.get(permission.agentId) ?? permission.agentId}
          onNotNow={notNow}
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  strip: { maxHeight: 320, flexGrow: 0 },
  stripContent: { gap: 6, paddingVertical: 8 },
  note: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4, minHeight: 24 },
  noteText: { fontSize: 13, color: theme.colors.foregroundMuted },
  failed: { color: theme.colors.statusDanger },
  runningDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.palette.amber[500],
  },
  chip: {
    maxWidth: 240,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  chipText: { fontSize: 13, color: theme.colors.foreground },
}));
