// The Home Chat's bot cards (spec 37.4.2, 37.2.6, 37.3.3): the daemon's notes — item changes with
// chips that open the item, Look around / Tidy memory runs, automation runs, waits that ended,
// hand-overs — and the approvals of the bot's workers. Ported from Orca dfdb4fda (MIT)
// src/renderer/src/components/native-chat/bot-items/NativeChatBotItemNoteRow.tsx:1-348 (note row,
// item chips), BotTidyUpLine.tsx and prompts/NativeChatApprovalCard.tsx:180-239.
//
// The agent timeline (AgentStreamView) has no slot for rows from outside its stream, so the cards
// render as a strip the Home Chat places right above its composer: the newest notes, oldest first,
// and the open worker approvals under them.
import { useCallback, useMemo, useState } from "react";
import { ScrollView } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type { Bot, BotMessage } from "@jagentdesk/protocol/bots/types";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { stripBotEnvelope } from "@/bots/envelope";
import { useBotHistory, useChatTree, useItems } from "@/bots/queries";
import { BotWorkerApprovalCard } from "./worker-approval-card";
import { runNoteText } from "./note-text";
import { botNoteRowKey, botNoteRows } from "./bot-item-note-clusters";
import { BotItemNoteRow, BotItemNoteRunRow, BotRunNoteRow } from "./bot-item-note-row";

/** Note rows the strip keeps; older ones stay in the chat history. */
const NOTES_SHOWN = 4;

function RunNoteRow({ serverId, message }: { serverId: string; message: BotMessage }) {
  const { t } = useTranslation();
  const note = message.note;
  const runAgentId = note?.runAgentId;
  const text = (note && runNoteText(t, note)) ?? stripBotEnvelope(message.text);
  const open = useCallback(() => {
    if (runAgentId) navigateToAgent({ serverId, agentId: runAgentId });
  }, [runAgentId, serverId]);
  return (
    <BotRunNoteRow
      label={text}
      running={note?.state === "running"}
      failed={note?.state === "failed"}
      onPress={runAgentId ? open : undefined}
      testID={`bot-note-${message.id}`}
    />
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
  const rows = useMemo(
    () => botNoteRows((history.data ?? []).filter((message) => message.note)).slice(-NOTES_SHOWN),
    [history.data],
  );
  const { pending, workers } = useWorkerApprovals(serverId, bot);
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const notNow = useCallback(
    (key: string) => setFolded((current) => new Set([...current, key])),
    [],
  );
  const approvals = pending.filter((permission) => !folded.has(permission.key));
  if (rows.length === 0 && approvals.length === 0) return null;
  return (
    <ScrollView
      style={styles.strip}
      contentContainerStyle={styles.stripContent}
      testID="bot-home-chat-cards"
    >
      {rows.map((row) => {
        const key = botNoteRowKey(row);
        if (row.kind === "run")
          return <BotItemNoteRunRow key={key} bot={bot} messages={row.messages} items={items} />;
        return row.message.note?.kind === "item" ? (
          <BotItemNoteRow key={key} bot={bot} message={row.message} items={items} />
        ) : (
          <RunNoteRow key={key} serverId={serverId} message={row.message} />
        );
      })}
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

const styles = StyleSheet.create({
  strip: { maxHeight: 320, flexGrow: 0 },
  // Orca's lines sit gap-1.5 apart.
  stripContent: { gap: 6, paddingVertical: 8 },
});
