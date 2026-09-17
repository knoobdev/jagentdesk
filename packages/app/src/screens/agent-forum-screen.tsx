import { memo, useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useIsFocused } from "@react-navigation/native";
import { MenuHeader } from "@/components/headers/menu-header";
import { useHosts, useHostRuntimeClient } from "@/runtime/host-runtime";
import type {
  ForumMessage,
  ForumRole,
  ForumTask,
  ForumTaskStatus,
  ForumTopicStatus,
  ForumTopicSummary,
  StoredForumTopic,
} from "@jagentdesk/protocol/messages";

// Team mode / Agent Forum, styled as a classic vBulletin discussion forum with a dark "geist" palette:
// a board of thread rows → each topic is a thread of postbit posts (avatar/username column + post
// body, with quote + reply-to), where the agents research, debate, plan and review like a human team.

// ---- palette (dark, geist-style) --------------------------------------------------------------
const C = {
  bg: "#000000",
  surface: "#0e0e0e",
  card: "#161616",
  cardAlt: "#1a1a1a",
  border: "#2e2e2e",
  borderSoft: "#242424",
  faint: "#454545",
  muted: "#878787",
  soft: "#a1a1a1",
  text: "#ededed",
  green: "#2d852d",
  greenDim: "#236b23",
  amber: "#f5a623",
  red: "#c83030",
} as const;
const FONT_MONO = '"Geist Mono","SFMono-Regular",Menlo,monospace';
const FONT_SANS = '"Geist",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';

const PHASES: { key: ForumTopicStatus; label: string }[] = [
  { key: "discussion", label: "Discussion" },
  { key: "planning", label: "Planning" },
  { key: "building", label: "Building" },
  { key: "review", label: "Review" },
  { key: "done", label: "Done" },
];
function phaseLabel(status: ForumTopicStatus): string {
  return (
    PHASES.find((p) => p.key === status)?.label ?? (status === "archived" ? "Archived" : status)
  );
}
function phaseIndex(status: ForumTopicStatus): number {
  const i = PHASES.findIndex((p) => p.key === status);
  return i < 0 ? 0 : i;
}

const ROLE_LABEL: Record<ForumRole, string> = {
  supervisor: "Supervisor",
  lead: "Lead",
  peer: "Coder",
  ba: "BA",
  tester: "Tester",
  pentester: "Pentester",
  reviewer: "Reviewer",
  user: "You",
  system: "System",
};
function roleColor(role: ForumRole): string {
  switch (role) {
    case "lead":
      return C.green;
    case "ba":
    case "reviewer":
      return C.amber;
    case "tester":
      return C.greenDim;
    case "pentester":
      return C.red;
    case "supervisor":
      return C.text;
    default:
      return C.faint;
  }
}
function phaseChipColor(status: ForumTopicStatus): string {
  if (status === "done") return C.green;
  if (status === "review") return C.amber;
  if (status === "archived") return C.faint;
  return C.soft;
}
function taskDotColor(status: ForumTaskStatus): string {
  if (status === "done") return C.green;
  if (status === "review") return C.amber;
  if (status === "blocked") return C.red;
  if (status === "in_progress") return C.soft;
  return C.faint;
}
function initial(label: string): string {
  const c = label.trim()[0];
  return c ? c.toUpperCase() : "?";
}
function timeAgo(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function upsertSummary(prev: ForumTopicSummary[], topic: StoredForumTopic): ForumTopicSummary[] {
  const rest = prev.filter((t) => t.id !== topic.id);
  return topic.status === "archived" ? rest : [toSummary(topic), ...rest];
}
function toSummary(topic: StoredForumTopic): ForumTopicSummary {
  return {
    id: topic.id,
    projectKey: topic.projectKey,
    title: topic.title,
    status: topic.status,
    createdAt_ms: topic.createdAt_ms,
    updatedAt_ms: topic.updatedAt_ms,
    participantCount: topic.participants.length,
    messageCount: topic.messages.length,
    taskCount: topic.tasks.length,
    doneTaskCount: topic.tasks.filter((t) => t.status === "done").length,
  };
}
function quotedOf(m: ForumMessage, byId: Map<string, ForumMessage>): ForumMessage | null {
  return m.quotedMessageId ? (byId.get(m.quotedMessageId) ?? null) : null;
}

// ---- screen -----------------------------------------------------------------------------------
export function AgentForumScreen(): ReactElement {
  const isFocused = useIsFocused();
  const hosts = useHosts();
  const [selected, setSelected] = useState<{ serverId: string; topicId: string } | null>(null);
  const onBack = useCallback(() => setSelected(null), []);

  if (!isFocused) return <View style={styles.container} />;

  let body: ReactElement;
  if (selected) {
    body = <TopicThread serverId={selected.serverId} topicId={selected.topicId} onBack={onBack} />;
  } else if (hosts.length === 0) {
    body = (
      <View style={styles.emptyWrap}>
        <Text style={styles.emptyText}>Connect to a host to open the team forum.</Text>
      </View>
    );
  } else {
    body = (
      <ScrollView contentContainerStyle={styles.boardBody}>
        <Text style={styles.tagline}>
          Turn on Team mode in a chat and send a coding request — the agents open a thread here to
          research, debate and plan it like a team, then create tasks, build, and review each other.
        </Text>
        {hosts.map((host) => (
          <HostTopics key={host.serverId} serverId={host.serverId} onOpen={setSelected} />
        ))}
      </ScrollView>
    );
  }

  return (
    <View style={styles.container}>
      <MenuHeader title="Team forum" />
      {body}
    </View>
  );
}

const HostTopics = memo(function HostTopics({
  serverId,
  onOpen,
}: {
  serverId: string;
  onOpen: (sel: { serverId: string; topicId: string }) => void;
}): ReactElement | null {
  const client = useHostRuntimeClient(serverId);
  const [topics, setTopics] = useState<ForumTopicSummary[]>([]);
  const onStreamed = useCallback((topic: StoredForumTopic) => {
    setTopics((prev) => upsertSummary(prev, topic));
  }, []);

  useEffect(() => {
    if (!client) return undefined;
    let alive = true;
    void (async () => {
      try {
        const list = await client.forumList();
        if (alive) setTopics(list);
      } catch {
        /* host may not support forums */
      }
    })();
    const unsub = client.subscribeForumStream(onStreamed);
    return () => {
      alive = false;
      unsub();
    };
  }, [client, onStreamed]);

  const sorted = useMemo(
    () => [...topics].sort((a, b) => b.updatedAt_ms - a.updatedAt_ms),
    [topics],
  );
  if (sorted.length === 0) return null;

  return (
    <View style={styles.board}>
      <View style={styles.statsRow}>
        <Stat n={sorted.length} label="threads" />
        <Stat n={sorted.filter((t) => t.status !== "done").length} label="active" />
        <Stat n={sorted.filter((t) => t.status === "done").length} label="shipped" />
      </View>
      <View style={styles.threadList}>
        <View style={styles.threadListHead}>
          <Text style={styles.colTopic}>THREAD</Text>
          <Text style={styles.colPhase}>PHASE</Text>
        </View>
        {sorted.map((topic) => (
          <TopicRow key={topic.id} serverId={serverId} topic={topic} onOpen={onOpen} />
        ))}
      </View>
    </View>
  );
});

const Stat = memo(function Stat({ n, label }: { n: number; label: string }): ReactElement {
  return (
    <View style={styles.stat}>
      <Text style={styles.statN}>{n}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
});

const TopicRow = memo(function TopicRow({
  serverId,
  topic,
  onOpen,
}: {
  serverId: string;
  topic: ForumTopicSummary;
  onOpen: (sel: { serverId: string; topicId: string }) => void;
}): ReactElement {
  const onPress = useCallback(
    () => onOpen({ serverId, topicId: topic.id }),
    [onOpen, serverId, topic.id],
  );
  return (
    <Pressable style={styles.threadRow} onPress={onPress} testID={`forum-topic-${topic.id}`}>
      <View style={styles.avatarSm}>
        <Text style={styles.avatarSmText}>{initial(topic.title)}</Text>
      </View>
      <View style={styles.threadMain}>
        <Text style={styles.threadTitle} numberOfLines={1}>
          {topic.title}
        </Text>
        <Text style={styles.threadMeta} numberOfLines={1}>
          {topic.participantCount} agents · {topic.messageCount} posts · {topic.doneTaskCount}/
          {topic.taskCount} tasks · {timeAgo(topic.updatedAt_ms)}
        </Text>
      </View>
      <PhaseChip status={topic.status} />
    </Pressable>
  );
});

const PhaseChip = memo(function PhaseChip({ status }: { status: ForumTopicStatus }): ReactElement {
  const color = phaseChipColor(status);
  return (
    <View style={[styles.chip, { borderColor: color }]}>
      <Text style={[styles.chipText, { color }]}>{phaseLabel(status).toUpperCase()}</Text>
    </View>
  );
});

// ---- topic thread (vBulletin postbit) ---------------------------------------------------------
const TopicThread = memo(function TopicThread({
  serverId,
  topicId,
  onBack,
}: {
  serverId: string;
  topicId: string;
  onBack: () => void;
}): ReactElement {
  const client = useHostRuntimeClient(serverId);
  const [topic, setTopic] = useState<StoredForumTopic | null>(null);

  useEffect(() => {
    if (!client) return undefined;
    let alive = true;
    void (async () => {
      try {
        const fetched = await client.forumGet(topicId);
        if (alive) setTopic(fetched);
      } catch {
        /* ignore */
      }
    })();
    const unsub = client.subscribeForumStream((next) => {
      if (next.id === topicId) setTopic(next);
    });
    return () => {
      alive = false;
      unsub();
    };
  }, [client, topicId]);

  const byId = useMemo(() => {
    const map = new Map<string, ForumMessage>();
    for (const m of topic?.messages ?? []) map.set(m.id, m);
    return map;
  }, [topic]);
  const [tab, setTab] = useState<"thread" | "board">("thread");

  return (
    <View style={styles.threadRoot}>
      <View style={styles.threadBar}>
        <Pressable onPress={onBack} testID="forum-back">
          <Text style={styles.backText}>‹ Forum index</Text>
        </Pressable>
        {topic ? <PhaseChip status={topic.status} /> : null}
      </View>
      {!topic ? (
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyText}>Loading…</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.threadBody}>
          <Text style={styles.postTitle}>{topic.title}</Text>
          <PhaseBar status={topic.status} />
          <TabBar tab={tab} onTab={setTab} boardCount={topic.tasks.length} />
          {tab === "thread" ? (
            topic.messages.map((m, i) => (
              <PostCard key={m.id} message={m} index={i + 1} quoted={quotedOf(m, byId)} />
            ))
          ) : (
            <KanbanBoard tasks={topic.tasks} />
          )}
        </ScrollView>
      )}
    </View>
  );
});

const PhaseBar = memo(function PhaseBar({ status }: { status: ForumTopicStatus }): ReactElement {
  const active = phaseIndex(status);
  return (
    <View style={styles.phaseBar}>
      {PHASES.map((p, i) => (
        <View key={p.key} style={styles.phaseStep}>
          <View style={[styles.phaseDot, i <= active ? styles.phaseDotOn : null]} />
          <Text style={[styles.phaseText, i <= active ? styles.phaseTextOn : null]}>
            {p.label.toUpperCase()}
          </Text>
        </View>
      ))}
    </View>
  );
});

const PostCard = memo(function PostCard({
  message,
  index,
  quoted,
}: {
  message: ForumMessage;
  index: number;
  quoted: ForumMessage | null;
}): ReactElement {
  const role = message.role;
  const color = roleColor(role);
  return (
    <View style={styles.post}>
      <View style={styles.postbit}>
        <View style={[styles.avatar, { backgroundColor: color }]}>
          <Text style={styles.avatarText}>{initial(message.authorLabel)}</Text>
        </View>
        <Text style={styles.postUser} numberOfLines={1}>
          {message.authorLabel}
        </Text>
        <Text style={[styles.postRank, { color }]}>{ROLE_LABEL[role]}</Text>
      </View>
      <View style={styles.postMain}>
        <View style={styles.postHead}>
          <Text style={styles.postNo}>#{index}</Text>
          {message.kind !== "message" ? <Text style={styles.kindTag}>{message.kind}</Text> : null}
          <Text style={styles.postTime}>{timeAgo(message.createdAt_ms)}</Text>
        </View>
        <View style={styles.postContent}>
          {message.replyToId ? (
            <Text style={styles.replyTo}>↳ in reply to an earlier post</Text>
          ) : null}
          {quoted ? (
            <View style={styles.quote}>
              <Text style={styles.quoteHead}>{quoted.authorLabel} wrote:</Text>
              <Text style={styles.quoteBody} numberOfLines={3}>
                {quoted.text}
              </Text>
            </View>
          ) : null}
          <Text style={styles.postBody}>{message.text}</Text>
        </View>
      </View>
    </View>
  );
});

const TabBar = memo(function TabBar({
  tab,
  onTab,
  boardCount,
}: {
  tab: "thread" | "board";
  onTab: (t: "thread" | "board") => void;
  boardCount: number;
}): ReactElement {
  const onThread = useCallback(() => onTab("thread"), [onTab]);
  const onBoard = useCallback(() => onTab("board"), [onTab]);
  return (
    <View style={styles.tabBar}>
      <Pressable
        onPress={onThread}
        style={[styles.tabBtn, tab === "thread" ? styles.tabBtnOn : null]}
      >
        <Text style={[styles.tabTxt, tab === "thread" ? styles.tabTxtOn : null]}>THREAD</Text>
      </Pressable>
      <Pressable
        onPress={onBoard}
        style={[styles.tabBtn, tab === "board" ? styles.tabBtnOn : null]}
      >
        <Text style={[styles.tabTxt, tab === "board" ? styles.tabTxtOn : null]}>
          BOARD · {boardCount}
        </Text>
      </Pressable>
    </View>
  );
});

const KANBAN: { status: ForumTaskStatus; label: string }[] = [
  { status: "backlog", label: "Backlog" },
  { status: "todo", label: "To do" },
  { status: "in_progress", label: "In progress" },
  { status: "review", label: "Review" },
  { status: "blocked", label: "Blocked" },
  { status: "done", label: "Done" },
];

const KanbanBoard = memo(function KanbanBoard({ tasks }: { tasks: ForumTask[] }): ReactElement {
  if (tasks.length === 0) {
    return (
      <Text style={styles.emptyBoard}>
        No tasks yet — the team is still discussing. Tasks appear here once they agree a plan.
      </Text>
    );
  }
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.kanban}>
      <View style={styles.kanbanRow}>
        {KANBAN.map((col) => {
          const colTasks = tasks.filter((t) => t.status === col.status);
          return (
            <View key={col.status} style={styles.column}>
              <Text style={styles.columnHead}>
                {col.label.toUpperCase()} · {colTasks.length}
              </Text>
              {colTasks.map((task) => (
                <View key={task.id} style={styles.kanbanCard}>
                  <View
                    style={[styles.cardStripe, { backgroundColor: taskDotColor(task.status) }]}
                  />
                  <Text style={styles.kanbanCardTitle} numberOfLines={3}>
                    {task.parentTaskId ? "↳ " : ""}
                    {task.title}
                  </Text>
                  <Text style={styles.kanbanCardMeta}>
                    {task.estimate !== "unknown" ? task.estimate.toUpperCase() : "—"}
                    {task.assigneeAgentId
                      ? ` · ${task.assigneeAgentId.slice(0, 8)}`
                      : " · unassigned"}
                  </Text>
                </View>
              ))}
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
});

// ---- styles -----------------------------------------------------------------------------------

// Forum uses a fixed dark palette (independent of the app light/dark theme); the theme arg is unused.
const styles = StyleSheet.create((_theme) => ({
  container: { flex: 1, backgroundColor: C.bg },
  boardBody: { padding: 20, gap: 20, maxWidth: 900, width: "100%", alignSelf: "center" },
  tagline: { color: C.muted, fontSize: 13, lineHeight: 20, fontFamily: FONT_SANS },
  emptyWrap: { flex: 1, alignItems: "center", justifyContent: "center", padding: 48 },
  emptyText: { color: C.muted, fontSize: 13, fontFamily: FONT_SANS },
  board: { gap: 16 },
  statsRow: { flexDirection: "row", gap: 32 },
  stat: { alignItems: "flex-start" },
  statN: { color: C.text, fontSize: 26, fontFamily: FONT_MONO, fontWeight: "600" },
  statLabel: {
    fontFamily: FONT_MONO,
    letterSpacing: 0.5,
    color: C.muted,
    fontSize: 11,
    textTransform: "uppercase",
  },
  threadList: {
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 10,
    overflow: "hidden",
    backgroundColor: C.surface,
  },
  threadListHead: {
    flexDirection: "row",
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: C.card,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  colTopic: { fontFamily: FONT_MONO, letterSpacing: 0.5, flex: 1, color: C.muted, fontSize: 11 },
  colPhase: { fontFamily: FONT_MONO, letterSpacing: 0.5, color: C.muted, fontSize: 11 },
  threadRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderTopWidth: 1,
    borderTopColor: C.borderSoft,
  },
  avatarSm: {
    alignItems: "center",
    justifyContent: "center",
    width: 30,
    height: 30,
    borderRadius: 6,
    backgroundColor: C.green,
  },
  avatarSmText: { color: C.bg, fontSize: 13, fontWeight: "700", fontFamily: FONT_MONO },
  threadMain: { flex: 1, gap: 3 },
  threadTitle: { color: C.text, fontSize: 15, fontWeight: "600", fontFamily: FONT_SANS },
  threadMeta: { fontFamily: FONT_MONO, letterSpacing: 0.5, color: C.muted, fontSize: 12 },
  chip: { borderRadius: 4, paddingHorizontal: 8, paddingVertical: 2, borderWidth: 1 },
  chipText: { fontFamily: FONT_MONO, letterSpacing: 0.5, fontSize: 10, fontWeight: "700" },
  threadRoot: { flex: 1, backgroundColor: C.bg },
  threadBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  backText: { color: C.green, fontSize: 13, fontFamily: FONT_MONO },
  threadBody: { padding: 20, gap: 12, maxWidth: 900, width: "100%", alignSelf: "center" },
  postTitle: { color: C.text, fontSize: 22, fontWeight: "700", fontFamily: FONT_SANS },
  phaseBar: { flexDirection: "row", flexWrap: "wrap", gap: 14, marginBottom: 6 },
  phaseStep: { flexDirection: "row", alignItems: "center", gap: 6 },
  phaseDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.faint },
  phaseDotOn: { backgroundColor: C.green },
  phaseText: { fontFamily: FONT_MONO, letterSpacing: 0.5, color: C.muted, fontSize: 10 },
  phaseTextOn: { color: C.text },
  post: {
    flexDirection: "row",
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 8,
    backgroundColor: C.card,
    overflow: "hidden",
  },
  postbit: {
    width: 116,
    alignItems: "center",
    gap: 6,
    paddingVertical: 14,
    paddingHorizontal: 8,
    backgroundColor: C.cardAlt,
    borderRightWidth: 1,
    borderRightColor: C.border,
  },
  avatar: {
    alignItems: "center",
    justifyContent: "center",
    width: 44,
    height: 44,
    borderRadius: 6,
  },
  avatarText: { color: C.bg, fontSize: 18, fontWeight: "700", fontFamily: FONT_MONO },
  postUser: {
    color: C.text,
    fontSize: 12,
    fontWeight: "600",
    textAlign: "center",
    fontFamily: FONT_SANS,
  },
  postRank: {
    fontFamily: FONT_MONO,
    letterSpacing: 0.5,
    fontSize: 10,
    textTransform: "uppercase",
    fontWeight: "700",
  },
  postMain: { flex: 1 },
  postHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: C.borderSoft,
  },
  postNo: { fontFamily: FONT_MONO, letterSpacing: 0.5, color: C.muted, fontSize: 11 },
  kindTag: {
    fontFamily: FONT_MONO,
    letterSpacing: 0.5,
    fontSize: 10,
    color: C.soft,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 4,
    paddingHorizontal: 6,
    textTransform: "uppercase",
    overflow: "hidden",
  },
  postTime: {
    fontFamily: FONT_MONO,
    letterSpacing: 0.5,
    color: C.muted,
    fontSize: 11,
    marginLeft: "auto",
  },
  postContent: { padding: 14, gap: 8 },
  replyTo: { fontFamily: FONT_MONO, letterSpacing: 0.5, color: C.muted, fontSize: 11 },
  quote: {
    borderLeftWidth: 2,
    borderLeftColor: C.green,
    backgroundColor: C.surface,
    borderRadius: 4,
    paddingVertical: 8,
    paddingHorizontal: 10,
    gap: 4,
  },
  quoteHead: { fontFamily: FONT_MONO, letterSpacing: 0.5, color: C.soft, fontSize: 11 },
  quoteBody: {
    color: C.muted,
    fontSize: 13,
    fontStyle: "italic",
    fontFamily: FONT_SANS,
    lineHeight: 18,
  },
  postBody: { color: C.text, fontSize: 14, lineHeight: 21, fontFamily: FONT_SANS },
  tabBar: { flexDirection: "row", gap: 6, marginTop: 4 },
  tabBtn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.card,
  },
  tabBtnOn: { backgroundColor: C.cardAlt, borderColor: C.faint },
  tabTxt: {
    fontFamily: FONT_MONO,
    letterSpacing: 0.5,
    color: C.muted,
    fontSize: 11,
    fontWeight: "700",
  },
  tabTxtOn: { color: C.text },
  emptyBoard: {
    color: C.muted,
    fontSize: 13,
    fontFamily: FONT_SANS,
    paddingVertical: 24,
    textAlign: "center",
  },
  kanban: { flexGrow: 0 },
  kanbanRow: { flexDirection: "row", gap: 12, paddingBottom: 8 },
  column: { width: 208, gap: 8 },
  columnHead: {
    fontFamily: FONT_MONO,
    letterSpacing: 0.5,
    color: C.muted,
    fontSize: 11,
    fontWeight: "700",
  },
  kanbanCard: {
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 8,
    backgroundColor: C.card,
    padding: 12,
    gap: 6,
    overflow: "hidden",
  },
  cardStripe: { position: "absolute", left: 0, top: 0, bottom: 0, width: 3 },
  kanbanCardTitle: { color: C.text, fontSize: 13, fontFamily: FONT_SANS, lineHeight: 18 },
  kanbanCardMeta: { fontFamily: FONT_MONO, letterSpacing: 0.5, color: C.muted, fontSize: 11 },
}));
