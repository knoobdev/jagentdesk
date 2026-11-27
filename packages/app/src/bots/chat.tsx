import { useCallback } from "react";
import { useEffect, useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type { Bot, BotMessage } from "@jagentdesk/protocol/bots/types";
import { PaneFocusProvider, createPaneFocusContextValue } from "@/panels/pane-context";
import { AgentStreamView } from "@/agent-stream/view";
import { useFetchQuery } from "@/data/query";
import { useAgentInitialization } from "@/hooks/use-agent-initialization";
import { useSessionStore, selectAgentTurnPresentation } from "@/stores/session-store";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { useBotsConnection, useBotAgent, botsKey } from "./queries";
import { QueryNotice, ErrorNotice } from "./ui";
import { Composer } from "@/composer";
import { useAgentInputDraft } from "@/composer/draft/input-draft";
import type { MessagePayload } from "@/composer/types";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { styles } from "./styles";
import { botIdFromLabels } from "./envelope";
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
  const role = t(`bots.jad.${message.role}`);
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
      {messages.length === 0 ? <Text style={styles.muted}>{t("bots.jad.messageHint")}</Text> : null}
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
  autoFocusKey,
}: {
  serverId: string;
  /** Stable per conversation (`bot:<id>`, `room:<id>`), so each keeps its own draft. */
  draftId: string;
  pending: boolean;
  error: Error | null;
  send: (text: string) => Promise<unknown>;
  hint: string;
  disabled?: boolean;
  /** Changing it focuses the input (Home Chat's "New automation" pre-fill). */
  autoFocusKey?: string;
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
      if (disabled) throw new Error(t("bots.jad.offline"));
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
        submitButtonAccessibilityLabel={t("bots.jad.send")}
        textSource={draft.textSource}
        textReplacement={draft.textReplacement}
        onChangeText={draft.editText}
        attachments={draft.attachments}
        onChangeAttachments={draft.setAttachments}
        cwd=""
        clearDraft={draft.clear}
        autoFocus={autoFocusKey !== undefined}
        autoFocusKey={autoFocusKey}
      />
    </View>
  );
}
