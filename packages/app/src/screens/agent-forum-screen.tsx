import { memo, useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { StyleSheet } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { useHosts, useHostRuntimeClient } from "@/runtime/host-runtime";
import type {
  ForumTaskStatus,
  ForumTopicStatus,
  ForumTopicSummary,
  StoredForumTopic,
} from "@jagentdesk/protocol/messages";

// Team mode / Agent Forum screen (docs/plans/active/agent-forum.md): topics where agents collaborate
// on a coding request, shown as a discussion thread + a kanban task board, live via forum.stream.

const TASK_COLUMNS: { status: ForumTaskStatus; label: string }[] = [
  { status: "backlog", label: "Backlog" },
  { status: "todo", label: "To do" },
  { status: "in_progress", label: "In progress" },
  { status: "review", label: "Review" },
  { status: "blocked", label: "Blocked" },
  { status: "done", label: "Done" },
];

// Fold a streamed topic into a summary list: drop archived, otherwise move it to the front.
function upsertSummary(prev: ForumTopicSummary[], topic: StoredForumTopic): ForumTopicSummary[] {
  const rest = prev.filter((t) => t.id !== topic.id);
  return topic.status === "archived" ? rest : [topicToSummary(topic), ...rest];
}

function topicToSummary(topic: StoredForumTopic): ForumTopicSummary {
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

export function AgentForumScreen(): ReactElement {
  const isFocused = useIsFocused();
  const hosts = useHosts();
  const [selected, setSelected] = useState<{ serverId: string; topicId: string } | null>(null);
  const onBack = useCallback(() => setSelected(null), []);

  if (!isFocused) return <View style={styles.container} />;

  let body: ReactElement;
  if (selected) {
    body = <TopicDetail serverId={selected.serverId} topicId={selected.topicId} onBack={onBack} />;
  } else if (hosts.length === 0) {
    body = (
      <View style={styles.emptyWrap}>
        <Text style={styles.emptyText}>Connect to a host to see Team-mode topics.</Text>
      </View>
    );
  } else {
    body = (
      <ScrollView contentContainerStyle={styles.listBody}>
        <Text style={styles.blurb}>
          Turn on Team mode in an agent chat and send a coding request — the agents open a topic
          here, plan it, split it into tasks, and work as a team.
        </Text>
        {hosts.map((host) => (
          <HostTopics key={host.serverId} serverId={host.serverId} onOpen={setSelected} />
        ))}
      </ScrollView>
    );
  }

  return (
    <View style={styles.container}>
      <MenuHeader title="Team" />
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
  // Named handler keeps the effect's callback nesting under the lint cap.
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
        // host may not support forums yet; leave the list empty
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
    <View style={styles.hostBlock}>
      {sorted.map((topic) => (
        <TopicCard key={topic.id} serverId={serverId} topic={topic} onOpen={onOpen} />
      ))}
    </View>
  );
});

const TopicCard = memo(function TopicCard({
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
    <Pressable style={styles.card} onPress={onPress} testID={`forum-topic-${topic.id}`}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle} numberOfLines={2}>
          {topic.title}
        </Text>
        <TopicStatusChip status={topic.status} />
      </View>
      <Text style={styles.cardMeta}>
        {topic.doneTaskCount}/{topic.taskCount} tasks · {topic.participantCount} agents ·{" "}
        {topic.messageCount} messages
      </Text>
    </Pressable>
  );
});

const TopicStatusChip = memo(function TopicStatusChip({
  status,
}: {
  status: ForumTopicStatus;
}): ReactElement {
  return (
    <View style={[styles.chip, styles[`chip_${status}`]]}>
      <Text style={styles.chipText}>{status.replace("_", " ")}</Text>
    </View>
  );
});

const TopicDetail = memo(function TopicDetail({
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
        // ignore; the detail shows a loading state until the stream delivers it
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
    <View style={styles.detailRoot}>
      <View style={styles.detailBar}>
        <Pressable onPress={onBack} testID="forum-back">
          <Text style={styles.backText}>‹ Topics</Text>
        </Pressable>
        {topic ? <TopicStatusChip status={topic.status} /> : null}
      </View>
      {!topic ? (
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyText}>Loading…</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.detailBody}>
          <Text style={styles.detailTitle}>{topic.title}</Text>
          <KanbanBoard topic={topic} />
          <Text style={styles.sectionLabel}>Discussion</Text>
          {topic.messages.map((m) => (
            <View key={m.id} style={styles.msgRow}>
              <Text style={styles.msgAuthor}>
                {m.authorLabel}
                <Text style={styles.msgRole}> · {m.role}</Text>
              </Text>
              <Text style={styles.msgText}>{m.text}</Text>
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
});

const KanbanBoard = memo(function KanbanBoard({
  topic,
}: {
  topic: StoredForumTopic;
}): ReactElement {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.board}>
      {TASK_COLUMNS.map((col) => {
        const tasks = topic.tasks.filter((t) => t.status === col.status);
        return (
          <View key={col.status} style={styles.column}>
            <Text style={styles.columnLabel}>
              {col.label} ({tasks.length})
            </Text>
            {tasks.map((task) => (
              <View key={task.id} style={styles.taskCard}>
                <Text style={styles.taskTitle} numberOfLines={3}>
                  {task.parentTaskId ? "↳ " : ""}
                  {task.title}
                </Text>
                <Text style={styles.taskMeta}>
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
    </ScrollView>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.surface0 },
  listBody: { padding: theme.spacing[4], gap: theme.spacing[3] },
  blurb: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  hostBlock: { gap: theme.spacing[3] },
  emptyWrap: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.spacing[8] },
  emptyText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  card: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    padding: theme.spacing[4],
    gap: theme.spacing[2],
  },
  cardHeader: { flexDirection: "row", alignItems: "flex-start", gap: theme.spacing[2] },
  cardTitle: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  cardMeta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
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
    textTransform: "capitalize",
  },
  chip_planning: { backgroundColor: theme.colors.surface2 },
  chip_in_progress: { backgroundColor: theme.colors.primary },
  chip_review: { backgroundColor: theme.colors.surface3 },
  chip_done: { backgroundColor: theme.colors.statusSuccess },
  chip_archived: { backgroundColor: theme.colors.surface2 },
  detailRoot: { flex: 1 },
  detailBar: {
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
  detailBody: { padding: theme.spacing[4], gap: theme.spacing[3] },
  detailTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
  },
  sectionLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: theme.spacing[2],
  },
  board: { flexGrow: 0 },
  column: {
    width: 200,
    marginRight: theme.spacing[3],
    gap: theme.spacing[2],
  },
  columnLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    textTransform: "uppercase",
  },
  taskCard: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    padding: theme.spacing[3],
    gap: theme.spacing[1],
  },
  taskTitle: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  taskMeta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  msgRow: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[3],
    gap: 2,
  },
  msgAuthor: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  msgRole: { color: theme.colors.foregroundMuted, fontWeight: theme.fontWeight.normal },
  msgText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
}));
