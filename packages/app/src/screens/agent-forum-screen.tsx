import { memo, useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View, type TextStyle, type ViewStyle } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { StyleSheet } from "react-native-unistyles";
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

// Team mode / Agent Forum (docs/plans/completed/agent-forum.md), styled as a classic discussion
// forum (vBulletin-ish): a board of topic threads → each topic is a thread of posts where the agents
// research, debate, plan and review like a human team; the resulting tasks are a secondary board.

// ---- phases -----------------------------------------------------------------------------------
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

// ---- roles ------------------------------------------------------------------------------------
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
function roleAvatarStyle(role: ForumRole): ViewStyle {
  return styles[`avatar_${role}`] ?? styles.avatar_peer;
}
function roleBadgeStyle(role: ForumRole): TextStyle {
  return styles[`badge_${role}`] ?? styles.badge_peer;
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

  const doneTopics = sorted.filter((t) => t.status === "done").length;
  return (
    <View style={styles.board}>
      <View style={styles.statsRow}>
        <Stat n={sorted.length} label="threads" />
        <Stat n={sorted.filter((t) => t.status !== "done").length} label="active" />
        <Stat n={doneTopics} label="done" />
      </View>
      <View style={styles.threadList}>
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
      <View style={[styles.avatar, styles.avatar_lead]}>
        <Text style={styles.avatarText}>{initial(topic.title)}</Text>
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
  return (
    <View style={[styles.chip, styles[`chip_${status}`] ?? styles.chip_discussion]}>
      <Text style={styles.chipText}>{phaseLabel(status)}</Text>
    </View>
  );
});

// ---- topic thread -----------------------------------------------------------------------------
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

  return (
    <View style={styles.threadRoot}>
      <View style={styles.threadBar}>
        <Pressable onPress={onBack} testID="forum-back">
          <Text style={styles.backText}>‹ Forum</Text>
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
          {topic.messages.map((m) => (
            <PostCard key={m.id} message={m} />
          ))}
          {topic.tasks.length > 0 ? <TasksSection tasks={topic.tasks} /> : null}
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
          <Text style={[styles.phaseText, i <= active ? styles.phaseTextOn : null]}>{p.label}</Text>
        </View>
      ))}
    </View>
  );
});

const PostCard = memo(function PostCard({ message }: { message: ForumMessage }): ReactElement {
  const role = message.role;
  return (
    <View style={styles.post}>
      <View style={styles.postSide}>
        <View style={[styles.avatar, roleAvatarStyle(role)]}>
          <Text style={styles.avatarText}>{initial(message.authorLabel)}</Text>
        </View>
      </View>
      <View style={styles.postMain}>
        <View style={styles.postHead}>
          <Text style={styles.postAuthor}>{message.authorLabel}</Text>
          <Text style={[styles.roleBadge, roleBadgeStyle(role)]}>{ROLE_LABEL[role]}</Text>
          {message.kind !== "message" ? <Text style={styles.kindBadge}>{message.kind}</Text> : null}
          <Text style={styles.postTime}>{timeAgo(message.createdAt_ms)}</Text>
        </View>
        <Text style={styles.postBody}>{message.text}</Text>
      </View>
    </View>
  );
});

const TasksSection = memo(function TasksSection({ tasks }: { tasks: ForumTask[] }): ReactElement {
  return (
    <View style={styles.tasksSection}>
      <Text style={styles.sectionLabel}>Decisions &amp; tasks</Text>
      {tasks.map((task) => (
        <View key={task.id} style={styles.taskRow}>
          <TaskDot status={task.status} />
          <Text style={styles.taskTitle} numberOfLines={2}>
            {task.parentTaskId ? "↳ " : ""}
            {task.title}
          </Text>
          <Text style={styles.taskMeta}>
            {task.status.replace("_", " ")}
            {task.estimate !== "unknown" ? ` · ${task.estimate.toUpperCase()}` : ""}
            {task.assigneeAgentId ? ` · ${task.assigneeAgentId.slice(0, 6)}` : ""}
          </Text>
        </View>
      ))}
    </View>
  );
});

const TaskDot = memo(function TaskDot({ status }: { status: ForumTaskStatus }): ReactElement {
  return <View style={[styles.taskDot, styles[`task_${status}`] ?? styles.task_backlog]} />;
});

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.surface0 },
  boardBody: { padding: theme.spacing[4], gap: theme.spacing[4] },
  tagline: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, lineHeight: 20 },
  emptyWrap: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.spacing[8] },
  emptyText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  board: { gap: theme.spacing[3] },
  statsRow: { flexDirection: "row", gap: theme.spacing[6] },
  stat: { alignItems: "flex-start" },
  statN: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.bold,
  },
  statLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  threadList: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
    backgroundColor: theme.colors.surface1,
  },
  threadRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  threadMain: { flex: 1, gap: 2 },
  threadTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  threadMeta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  // avatars
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    color: theme.colors.accentForeground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.bold,
  },
  avatar_supervisor: { backgroundColor: theme.colors.foreground },
  avatar_lead: { backgroundColor: theme.colors.primary },
  avatar_peer: { backgroundColor: theme.colors.accent },
  avatar_ba: { backgroundColor: theme.colors.statusWarning },
  avatar_tester: { backgroundColor: theme.colors.statusSuccess },
  avatar_pentester: { backgroundColor: theme.colors.statusDanger },
  avatar_reviewer: { backgroundColor: theme.colors.accent },
  avatar_user: { backgroundColor: theme.colors.surface3 },
  avatar_system: { backgroundColor: theme.colors.surface3 },
  // chips (phase)
  chip: {
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    backgroundColor: theme.colors.surface2,
  },
  chipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  chip_discussion: { backgroundColor: theme.colors.surface2 },
  chip_planning: { backgroundColor: theme.colors.surface3 },
  chip_building: { backgroundColor: theme.colors.primary },
  chip_review: { backgroundColor: theme.colors.statusWarning },
  chip_done: { backgroundColor: theme.colors.statusSuccess },
  chip_archived: { backgroundColor: theme.colors.surface2 },
  // thread detail
  threadRoot: { flex: 1 },
  threadBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  backText: {
    color: theme.colors.primary,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  threadBody: {
    padding: theme.spacing[4],
    gap: theme.spacing[3],
    maxWidth: 860,
    width: "100%",
    alignSelf: "center",
  },
  postTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.bold,
  },
  // phase bar
  phaseBar: { flexDirection: "row", gap: theme.spacing[3], marginBottom: theme.spacing[2] },
  phaseStep: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  phaseDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.surface3 },
  phaseDotOn: { backgroundColor: theme.colors.primary },
  phaseText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  phaseTextOn: { color: theme.colors.foreground, fontWeight: theme.fontWeight.medium },
  // posts
  post: {
    flexDirection: "row",
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
  },
  postSide: { alignItems: "center" },
  postMain: { flex: 1, gap: theme.spacing[1] },
  postHead: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2], flexWrap: "wrap" },
  postAuthor: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  roleBadge: {
    fontSize: 10,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.accentForeground,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 1,
    borderRadius: theme.borderRadius.full,
    overflow: "hidden",
    textTransform: "uppercase",
  },
  badge_supervisor: { backgroundColor: theme.colors.foreground },
  badge_lead: { backgroundColor: theme.colors.primary },
  badge_peer: { backgroundColor: theme.colors.accent },
  badge_ba: { backgroundColor: theme.colors.statusWarning },
  badge_tester: { backgroundColor: theme.colors.statusSuccess },
  badge_pentester: { backgroundColor: theme.colors.statusDanger },
  badge_reviewer: { backgroundColor: theme.colors.accent },
  badge_user: { backgroundColor: theme.colors.surface3, color: theme.colors.foreground },
  badge_system: { backgroundColor: theme.colors.surface3, color: theme.colors.foreground },
  kindBadge: {
    fontSize: 10,
    color: theme.colors.foregroundMuted,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[2],
    overflow: "hidden",
    textTransform: "uppercase",
  },
  postTime: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginLeft: "auto",
  },
  postBody: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, lineHeight: 20 },
  // tasks
  tasksSection: {
    marginTop: theme.spacing[3],
    gap: theme.spacing[2],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing[3],
  },
  sectionLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  taskRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  taskDot: { width: 8, height: 8, borderRadius: 4 },
  task_backlog: { backgroundColor: theme.colors.surface3 },
  task_todo: { backgroundColor: theme.colors.surface3 },
  task_in_progress: { backgroundColor: theme.colors.primary },
  task_review: { backgroundColor: theme.colors.statusWarning },
  task_blocked: { backgroundColor: theme.colors.statusDanger },
  task_done: { backgroundColor: theme.colors.statusSuccess },
  taskTitle: { flex: 1, color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  taskMeta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
}));
