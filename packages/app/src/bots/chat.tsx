import { useCallback } from "react";
import { useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type { Bot, BotMessage } from "@jagentdesk/protocol/bots/types";
import { PaneFocusProvider, createPaneFocusContextValue } from "@/panels/pane-context";
import { AgentStreamView } from "@/agent-stream/view";
import { Button } from "@/components/ui/button";
import { useFetchQuery } from "@/data/query";
import { useAgentInitialization } from "@/hooks/use-agent-initialization";
import { useSessionStore, selectAgentTurnPresentation } from "@/stores/session-store";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { useBotsConnection, useBotAgent, useBotsMutation, useBotHistory, botsKey } from "./queries";
import { QueryNotice, ErrorNotice } from "./ui";
import { Composer } from "@/composer";
import { useAgentInputDraft } from "@/composer/draft/input-draft";
import type { MessagePayload } from "@/composer/types";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { styles } from "./styles";
import { mergeMessages } from "./model";
import { botIdFromLabels } from "./envelope";
import { HowToAsk } from "./help";
export function AgentTimeline({ serverId, agentId }: { serverId: string; agentId: string }) {
  const { client, enabled } = useBotsConnection(serverId);
  const agent = useBotAgent(serverId, agentId);
  const { ensureAgentIsInitialized } = useAgentInitialization({ serverId, client });
  const history = useFetchQuery({
    queryKey: [...botsKey(serverId), "timeline", agentId],
    enabled,
    dataShape: "value",
    staleTimeMs: 1000,
    queryFn: async () => {
      await ensureAgentIsInitialized(agentId);
      return true;
    },
  });
  const bridge = useSessionStore((state) => state.sessions[serverId]?.viewedTimelineSync);
  useEffect(() => {
    if (!bridge) return;
    const source = `bots:${serverId}:${agentId}`;
    bridge.replaceVisibleAgentIds(source, [agentId]);
    return () => bridge.replaceVisibleAgentIds(source, []);
  }, [bridge, serverId, agentId]);
  const stream = useSessionStore((state) => state.sessions[serverId]?.agentStreamTail.get(agentId));
  const turn = useSessionStore(
    useShallow((state) => selectAgentTurnPresentation(state.sessions[serverId], agentId)),
  );
  const pending = useSessionStore(
    useShallow((state) =>
      Array.from(state.sessions[serverId]?.pendingPermissions.values() ?? []).filter(
        (permission) => permission.agentId === agentId,
      ),
    ),
  );
  const permissions = useMemo(
    () => new Map(pending.map((permission) => [permission.key, permission])),
    [pending],
  );
  const focus = useMemo(
    () => createPaneFocusContextValue({ isWorkspaceFocused: true, isPaneFocused: true }),
    [],
  );
  const context = useMemo(() => {
    if (!agent.data) return null;
    const snapshot = normalizeAgentSnapshot(agent.data.agent, serverId);
    return { ...snapshot, botId: botIdFromLabels(snapshot.labels) };
  }, [agent.data, serverId]);
  return (
    <View style={styles.column}>
      <QueryNotice query={agent} />
      <QueryNotice query={history} />
      {context ? (
        <PaneFocusProvider value={focus}>
          <AgentStreamView
            agentId={agentId}
            serverId={serverId}
            context={context}
            streamItems={stream ?? []}
            pendingPermissions={permissions}
            turnPresentation={turn}
            isAuthoritativeHistoryReady={history.isSuccess}
          />
        </PaneFocusProvider>
      ) : null}
    </View>
  );
}
function MessageRow({ message, speaker }: { message: BotMessage; speaker?: string }) {
  const { t } = useTranslation();
  const role = t(`bots.${message.role}`);
  const label = speaker && message.role === "assistant" ? speaker : role;
  const rowStyle = [styles.message, message.role === "user" && styles.userMessage];
  return (
    <View style={rowStyle}>
      <Text style={styles.muted}>
        {label} · {new Date(message.createdAt_ms).toLocaleString()}
      </Text>
      <Text selectable style={styles.text}>
        {message.text}
      </Text>
    </View>
  );
}
export function Messages({
  messages,
  bots,
}: {
  messages: readonly BotMessage[];
  bots?: readonly Bot[];
}) {
  const { t } = useTranslation();
  const names = useMemo(() => new Map(bots?.map((bot) => [bot.id, bot.name])), [bots]);
  return (
    <ScrollView contentContainerStyle={styles.body} testID="bots-chat-history">
      {messages.map((message) => (
        <MessageRow key={message.id} message={message} speaker={names.get(message.botId)} />
      ))}
      {messages.length === 0 ? <Text style={styles.muted}>{t("bots.messageHint")}</Text> : null}
    </ScrollView>
  );
}
/**
 * The shared composer, sending plain text into a bot's inbox (or a room) instead of an agent
 * turn. The draft key is synthetic so the composer never treats the supervisor as its target:
 * the daemon queues the message behind any running turn and adds the `[source]` envelope.
 */
export function MessageComposer({
  serverId,
  draftId,
  pending,
  error,
  send,
  hint,
  disabled = false,
}: {
  serverId: string;
  /** Stable per conversation (`bot:<id>`, `room:<id>`), so each keeps its own draft. */
  draftId: string;
  pending: boolean;
  error: Error | null;
  send: (text: string) => Promise<unknown>;
  hint: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const composerId = `bots-${draftId}`;
  const draftKey = useMemo(
    () => buildDraftStoreKey({ serverId, agentId: composerId }),
    [serverId, composerId],
  );
  const draft = useAgentInputDraft({ draftKey });
  const submit = useCallback(
    async function submit(payload: MessagePayload) {
      if (disabled) throw new Error(t("bots.offline"));
      const text = payload.text.trim();
      if (!text) return;
      await send(text);
    },
    [disabled, send, t],
  );
  return (
    <View style={styles.composer}>
      <ErrorNotice error={error} />
      <Composer
        agentId={composerId}
        serverId={serverId}
        isPaneFocused
        inputMode="message"
        placeholder={hint}
        onSubmitMessage={submit}
        isSubmitLoading={pending || disabled}
        submitButtonTestID="bots-send"
        submitButtonAccessibilityLabel={t("bots.send")}
        textSource={draft.textSource}
        textReplacement={draft.textReplacement}
        onChangeText={draft.editText}
        attachments={draft.attachments}
        onChangeAttachments={draft.setAttachments}
        cwd=""
        clearDraft={draft.clear}
      />
    </View>
  );
}
export function BotChat({ serverId, bot }: { serverId: string; bot: Bot }) {
  const { t } = useTranslation();
  const history = useBotHistory(serverId, bot.id);
  const send = useBotsMutation(serverId, "bots.chat.send.request");
  const { client, enabled } = useBotsConnection(serverId);
  const [showHistory, setShowHistory] = useState(false);
  const [older, setOlder] = useState<BotMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const messages = mergeMessages(older, history.data ?? []);
  const loadEarlier = useCallback(
    async function loadEarlier() {
      if (!client || !messages.length) return;
      setLoading(true);
      setError(null);
      try {
        const result = await client.botsRequest("bots.chat.history.request", {
          botId: bot.id,
          before_ms: messages[0].createdAt_ms,
          limit: 200,
        });
        setOlder((previous) => mergeMessages(previous, result.messages));
      } catch (caught) {
        setError(caught instanceof Error ? caught : new Error(String(caught)));
      } finally {
        setLoading(false);
      }
    },
    [client, messages, setLoading, setError, bot, setOlder],
  );
  const toggleHistory = useCallback(
    function toggleHistory() {
      setShowHistory((value) => !value);
    },
    [setShowHistory],
  );
  const sendMessage = useCallback(
    function sendMessage(text: string) {
      return send.mutateAsync({ botId: bot.id, text });
    },
    [send, bot],
  );
  const useTimeline = Boolean(bot.agentId && !showHistory);
  // A bot that has never been asked anything: no Supervisor yet and no stored messages.
  const fresh = !bot.agentId && history.isSuccess && messages.length === 0;
  let conversation;
  if (fresh)
    conversation = (
      <>
        <View style={styles.grow} />
        <HowToAsk serverId={serverId} bot={bot} />
      </>
    );
  else if (useTimeline && bot.agentId)
    conversation = <AgentTimeline serverId={serverId} agentId={bot.agentId} />;
  else
    conversation = (
      <>
        <QueryNotice query={history} />
        <Messages messages={messages} />
      </>
    );
  return (
    <View style={styles.column}>
      <View style={styles.row}>
        <Button size="sm" variant="ghost" onPress={toggleHistory}>
          {t(showHistory ? "bots.supervisor" : "bots.history")}
        </Button>
        {showHistory ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={loading || messages.length === 0}
            loading={loading}
            onPress={loadEarlier}
          >
            {t("bots.loadEarlier")}
          </Button>
        ) : null}
      </View>
      <ErrorNotice error={error} />
      {conversation}
      <MessageComposer
        serverId={serverId}
        draftId={`bot:${bot.id}`}
        pending={send.isPending}
        error={send.error}
        send={sendMessage}
        hint={t("bots.message")}
        disabled={!enabled}
      />
    </View>
  );
}
