import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { Animated, Modal, Pressable, ScrollView, Text, View } from "react-native";
import Markdown from "react-native-markdown-display";
import Svg, { Circle, G, Rect, Text as SvgText } from "react-native-svg";
import { StyleSheet } from "react-native-unistyles";
import { useIsFocused } from "@react-navigation/native";
import { MenuHeader } from "@/components/headers/menu-header";
import { useHosts, useHostRuntimeClient } from "@/runtime/host-runtime";
import type {
  ForumEpicStat,
  ForumMessage,
  ForumRole,
  ForumTask,
  ForumTaskComment,
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
const THREADS_PER_PAGE = 8;
const POSTS_PER_PAGE = 5;
const ACTIVITY_PER_PAGE = 8;

// Distinct, dark-safe status hues for the dashboard charts + kanban stripes (validated for CVD
// separation; always shown alongside a text label, never color alone). One hue per status, fixed.
const STATUS_COLOR: Record<ForumTaskStatus, string> = {
  backlog: "#8a8f98",
  todo: "#3f8fd6",
  in_progress: "#17b8b0",
  review: "#f5a623",
  blocked: "#e05442",
  done: "#35b45a",
};

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
  return STATUS_COLOR[status] ?? C.faint;
}
const STATUS_LABEL: Record<ForumTaskStatus, string> = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  review: "Review",
  blocked: "Blocked",
  done: "Done",
};
function statusLabel(status: ForumTaskStatus): string {
  return STATUS_LABEL[status] ?? status;
}
// Turn the t-shirt estimate into a readable hours figure (what humans actually track).
const ESTIMATE_HOURS: Record<string, string> = {
  unknown: "—",
  xs: "~1h",
  s: "~2h",
  m: "~4h",
  l: "~1d (8h)",
  xl: "~2d (16h)",
};
function estimateLabel(estimate: string): string {
  return ESTIMATE_HOURS[estimate] ?? "—";
}
function myVote(message: ForumMessage): "up" | "down" | null {
  if (message.upvoters.includes("user")) return "up";
  if (message.downvoters.includes("user")) return "down";
  return null;
}
function scoreColorOf(score: number): string {
  if (score > 0) return C.green;
  if (score < 0) return C.red;
  return C.muted;
}
// Stable no-op to stop backdrop-press propagation without allocating a new fn each render.
const NOOP = (): void => undefined;
function withoutTopic(list: ForumTopicSummary[], topicId: string): ForumTopicSummary[] {
  return list.filter((t) => t.id !== topicId);
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
  const taskStatusCounts: Record<string, number> = {};
  const epicMap = new Map<string, ForumEpicStat>();
  for (const t of topic.tasks) {
    taskStatusCounts[t.status] = (taskStatusCounts[t.status] ?? 0) + 1;
    if (t.epic) {
      const entry = epicMap.get(t.epic) ?? { name: t.epic, done: 0, total: 0 };
      entry.total += 1;
      if (t.status === "done") entry.done += 1;
      epicMap.set(t.epic, entry);
    }
  }
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
    taskStatusCounts,
    epics: [...epicMap.values()],
  };
}
function quotedOf(m: ForumMessage, byId: Map<string, ForumMessage>): ForumMessage | null {
  return m.quotedMessageId ? (byId.get(m.quotedMessageId) ?? null) : null;
}
function epicSummaries(tasks: ForumTask[]): { name: string; done: number; total: number }[] {
  const map = new Map<string, { name: string; done: number; total: number }>();
  for (const t of tasks) {
    if (!t.epic) continue;
    const e = map.get(t.epic) ?? { name: t.epic, done: 0, total: 0 };
    e.total += 1;
    if (t.status === "done") e.done += 1;
    map.set(t.epic, e);
  }
  return [...map.values()];
}

// How many times a task was kicked back into work from review/done (a reviewer's request_changes, or
// a done task re-opened), plus the reason recorded on each — surfaced so the board explains churn.
function reopenInfo(task: ForumTask): {
  count: number;
  reasons: { at_ms: number; note: string }[];
} {
  const evs = task.history.filter(
    (h) => h.to === "in_progress" && (h.from === "review" || h.from === "done"),
  );
  return {
    count: evs.length,
    reasons: evs.map((e) => ({ at_ms: e.at_ms, note: e.note ?? "changes requested" })),
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

// Smooth mount/transition fade — remount (via `key`) on tab/page change to re-run.
const FadeIn = memo(function FadeIn({ children }: { children: ReactNode }): ReactElement {
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    opacity.setValue(0);
    Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }).start();
  }, [opacity]);
  const style = useMemo(() => ({ opacity }), [opacity]);
  return <Animated.View style={style}>{children}</Animated.View>;
});

// A gently pulsing placeholder block for loading states.
const SkeletonBlock = memo(function SkeletonBlock({
  height,
  width,
  radius,
}: {
  height: number;
  width?: number | `${number}%`;
  radius?: number;
}): ReactElement {
  const pulse = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.4, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  const style = useMemo(
    () => ({
      height,
      width: width ?? ("100%" as const),
      borderRadius: radius ?? 6,
      backgroundColor: C.card,
      opacity: pulse,
    }),
    [height, width, radius, pulse],
  );
  return <Animated.View style={style} />;
});

const ThreadSkeleton = memo(function ThreadSkeleton(): ReactElement {
  return (
    <View style={styles.threadBody}>
      <SkeletonBlock height={22} width="60%" />
      <SkeletonBlock height={14} width="40%" />
      {[0, 1, 2].map((i) => (
        <View key={i} style={styles.skeletonPost}>
          <SkeletonBlock height={44} width={44} radius={6} />
          <View style={styles.skeletonBody}>
            <SkeletonBlock height={12} width="90%" />
            <SkeletonBlock height={12} width="80%" />
            <SkeletonBlock height={12} width="55%" />
          </View>
        </View>
      ))}
    </View>
  );
});

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

  const onDelete = useCallback(
    (topicId: string) => {
      setTopics((prev) => withoutTopic(prev, topicId));
      void client?.forumDelete(topicId).catch(NOOP);
    },
    [client],
  );

  const sorted = useMemo(
    () => [...topics].sort((a, b) => b.updatedAt_ms - a.updatedAt_ms),
    [topics],
  );
  const [page, setPage] = useState(0);
  if (sorted.length === 0) return null;

  const pageCount = Math.max(1, Math.ceil(sorted.length / THREADS_PER_PAGE));
  const clamped = Math.min(page, pageCount - 1);
  const pageItems = sorted.slice(clamped * THREADS_PER_PAGE, (clamped + 1) * THREADS_PER_PAGE);

  return (
    <View style={styles.board}>
      <Dashboard summaries={sorted} />
      <View style={styles.threadList}>
        <View style={styles.threadListHead}>
          <Text style={styles.colTopic}>THREAD</Text>
          <Text style={styles.colPhase}>PHASE</Text>
        </View>
        {pageItems.map((topic) => (
          <TopicRow
            key={topic.id}
            serverId={serverId}
            topic={topic}
            onOpen={onOpen}
            onDelete={onDelete}
          />
        ))}
      </View>
      {pageCount > 1 ? <Pager page={clamped} pageCount={pageCount} onPage={setPage} /> : null}
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

// ---- dashboard (overview + charts) ------------------------------------------------------------
const STATUS_META: { key: ForumTaskStatus; label: string }[] = [
  { key: "backlog", label: "Backlog" },
  { key: "todo", label: "To do" },
  { key: "in_progress", label: "In progress" },
  { key: "review", label: "Review" },
  { key: "blocked", label: "Blocked" },
  { key: "done", label: "Done" },
];

const DONUT_SIZE = 168;
const DONUT_STROKE = 22;

// A real SVG donut of the task-status composition, drawn as stroked arcs via strokeDasharray with a
// 2px surface gap between segments; the hero total sits in the hole. Legend lives beside it (identity
// is never color-alone).
const StatusDonut = memo(function StatusDonut({
  segments,
  total,
}: {
  segments: { key: ForumTaskStatus; label: string; value: number; color: string }[];
  total: number;
}): ReactElement {
  const r = (DONUT_SIZE - DONUT_STROKE) / 2;
  const circ = 2 * Math.PI * r;
  const center = DONUT_SIZE / 2;
  const gap = total > 1 ? 0.012 : 0; // fraction of the ring left as a spacer between arcs
  let acc = 0;
  const arcs = segments
    .filter((s) => s.value > 0)
    .map((s) => {
      const frac = s.value / total;
      const dash = Math.max(0, (frac - gap) * circ);
      const arc = (
        <Circle
          key={s.key}
          cx={center}
          cy={center}
          r={r}
          fill="none"
          stroke={s.color}
          strokeWidth={DONUT_STROKE}
          strokeDasharray={`${dash} ${circ - dash}`}
          strokeDashoffset={-acc * circ}
        />
      );
      acc += frac;
      return arc;
    });
  return (
    <Svg width={DONUT_SIZE} height={DONUT_SIZE}>
      <G rotation={-90} origin={`${center}, ${center}`}>
        <Circle
          cx={center}
          cy={center}
          r={r}
          fill="none"
          stroke={C.cardAlt}
          strokeWidth={DONUT_STROKE}
        />
        {total > 0 ? arcs : null}
      </G>
      <SvgText
        x={center}
        y={center + 2}
        fill={C.text}
        fontSize={34}
        fontWeight="700"
        fontFamily={FONT_MONO}
        textAnchor="middle"
      >
        {total}
      </SvgText>
      <SvgText
        x={center}
        y={center + 22}
        fill={C.muted}
        fontSize={11}
        fontFamily={FONT_MONO}
        textAnchor="middle"
      >
        TASKS
      </SvgText>
    </Svg>
  );
});

const EPIC_BAR_W = 260;
const EPIC_ROW_H = 30;
const EPIC_LABEL_W = 76;

// A real SVG horizontal bar chart of tasks per epic: a muted track (total) with a green fill (done)
// and a done/total tag — a progress-by-epic view, direct-labelled.
const EpicBars = memo(function EpicBars({ epics }: { epics: ForumEpicStat[] }): ReactElement {
  const max = Math.max(1, ...epics.map((e) => e.total));
  const plotW = EPIC_BAR_W - EPIC_LABEL_W - 40;
  const height = epics.length * EPIC_ROW_H + 4;
  return (
    <Svg width={EPIC_BAR_W} height={height}>
      {epics.map((e, i) => {
        const y = i * EPIC_ROW_H + 4;
        const totalW = Math.max(3, (e.total / max) * plotW);
        const doneW = (e.done / max) * plotW;
        return (
          <G key={e.name}>
            <SvgText x={0} y={y + 14} fill={C.soft} fontSize={12} fontFamily={FONT_SANS}>
              {e.name}
            </SvgText>
            <Rect x={EPIC_LABEL_W} y={y + 2} width={totalW} height={14} rx={4} fill={C.cardAlt} />
            {doneW > 0 ? (
              <Rect
                x={EPIC_LABEL_W}
                y={y + 2}
                width={Math.max(4, doneW)}
                height={14}
                rx={4}
                fill={STATUS_COLOR.done}
              />
            ) : null}
            <SvgText
              x={EPIC_LABEL_W + totalW + 8}
              y={y + 14}
              fill={C.muted}
              fontSize={12}
              fontFamily={FONT_MONO}
            >
              {e.done}/{e.total}
            </SvgText>
          </G>
        );
      })}
    </Svg>
  );
});

function aggregateEpics(summaries: ForumTopicSummary[]): ForumEpicStat[] {
  const map = new Map<string, ForumEpicStat>();
  for (const s of summaries) {
    for (const e of s.epics) {
      const entry = map.get(e.name) ?? { name: e.name, done: 0, total: 0 };
      entry.done += e.done;
      entry.total += e.total;
      map.set(e.name, entry);
    }
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

const Dashboard = memo(function Dashboard({
  summaries,
}: {
  summaries: ForumTopicSummary[];
}): ReactElement {
  const agg = useMemo(() => {
    const status: Record<string, number> = {};
    let posts = 0;
    let tasks = 0;
    for (const s of summaries) {
      posts += s.messageCount;
      tasks += s.taskCount;
      for (const [k, v] of Object.entries(s.taskStatusCounts)) status[k] = (status[k] ?? 0) + v;
    }
    const active = summaries.filter((s) => s.status !== "done" && s.status !== "archived").length;
    const done = summaries.filter((s) => s.status === "done").length;
    return { status, epics: aggregateEpics(summaries), posts, tasks, active, done };
  }, [summaries]);
  const segments = STATUS_META.map((s) => ({
    key: s.key,
    label: s.label,
    value: agg.status[s.key] ?? 0,
    color: STATUS_COLOR[s.key],
  }));

  return (
    <View style={styles.dashboard}>
      <Text style={styles.dashLabel}>OVERVIEW</Text>
      <View style={styles.statsRow}>
        <Stat n={summaries.length} label="threads" />
        <Stat n={agg.active} label="active" />
        <Stat n={agg.done} label="shipped" />
        <Stat n={agg.posts} label="posts" />
        <Stat n={agg.tasks} label="tasks" />
      </View>
      <View style={styles.chartsRow}>
        <View style={styles.chartCard}>
          <Text style={styles.chartTitle}>TASKS BY STATUS</Text>
          <View style={styles.donutRow}>
            <StatusDonut segments={segments} total={agg.tasks} />
            <View style={styles.legend}>
              {segments
                .filter((s) => s.value > 0)
                .map((s) => (
                  <View key={s.key} style={styles.legendRow}>
                    <View style={[styles.legendDot, { backgroundColor: s.color }]} />
                    <Text style={styles.legendLabel}>{s.label}</Text>
                    <Text style={styles.legendN}>{s.value}</Text>
                  </View>
                ))}
            </View>
          </View>
        </View>
        {agg.epics.length > 0 ? (
          <View style={styles.chartCard}>
            <Text style={styles.chartTitle}>TASKS BY EPIC</Text>
            <EpicBars epics={agg.epics} />
          </View>
        ) : null}
      </View>
    </View>
  );
});

const Pager = memo(function Pager({
  page,
  pageCount,
  onPage,
}: {
  page: number;
  pageCount: number;
  onPage: (p: number) => void;
}): ReactElement {
  const prev = useCallback(() => onPage(Math.max(0, page - 1)), [onPage, page]);
  const next = useCallback(
    () => onPage(Math.min(pageCount - 1, page + 1)),
    [onPage, page, pageCount],
  );
  return (
    <View style={styles.pager}>
      <Pressable onPress={prev} disabled={page === 0} style={styles.pagerBtn}>
        <Text style={[styles.pagerTxt, page === 0 ? styles.pagerTxtOff : null]}>‹ Prev</Text>
      </Pressable>
      <Text style={styles.pagerInfo}>
        {page + 1} / {pageCount}
      </Text>
      <Pressable onPress={next} disabled={page >= pageCount - 1} style={styles.pagerBtn}>
        <Text style={[styles.pagerTxt, page >= pageCount - 1 ? styles.pagerTxtOff : null]}>
          Next ›
        </Text>
      </Pressable>
    </View>
  );
});

// Only these kinds are real DISCUSSION and get a full post card; the rest (status updates, role
// reviews, handbacks, system notes) are board activity — rendered as a compact activity row, not a post.
const DISCUSSION_KINDS = new Set(["message", "research", "proposal", "question", "decision"]);
function isDiscussion(m: ForumMessage): boolean {
  return DISCUSSION_KINDS.has(m.kind);
}
function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim() ?? text
  );
}

// A slim, non-post activity line for status/review/system events, so the thread stays about discussion.
const ActivityRow = memo(function ActivityRow({
  message,
}: {
  message: ForumMessage;
}): ReactElement {
  const color = roleColor(message.role);
  return (
    <View style={styles.activityRow}>
      <View style={[styles.activityDot, { backgroundColor: color }]} />
      <Text style={styles.activityText} numberOfLines={2}>
        <Text style={styles.activityWho}>{message.authorLabel}</Text>
        <Text style={styles.activityKind}> · {message.kind} · </Text>
        {firstLine(message.text)}
      </Text>
      <Text style={styles.activityTime}>{timeAgo(message.createdAt_ms)}</Text>
    </View>
  );
});

// Discussion posts only (activity lives in ActivitySection), paginated on their own. `startIndex` is
// the post number of the first item (the opening #1 post is rendered separately by the thread).
const DiscussionPosts = memo(function DiscussionPosts({
  posts,
  byId,
  onVote,
  startIndex,
}: {
  posts: ForumMessage[];
  byId: Map<string, ForumMessage>;
  onVote: (messageId: string, direction: "up" | "down" | "clear") => void;
  startIndex: number;
}): ReactElement | null {
  const [page, setPage] = useState(0);
  if (posts.length === 0) return null;
  const pageCount = Math.max(1, Math.ceil(posts.length / POSTS_PER_PAGE));
  const clamped = Math.min(page, pageCount - 1);
  const start = clamped * POSTS_PER_PAGE;
  const items = posts.slice(start, start + POSTS_PER_PAGE);
  return (
    <FadeIn key={clamped}>
      <View style={styles.postStack}>
        {items.map((m, i) => (
          <PostCard
            key={m.id}
            message={m}
            index={startIndex + start + i}
            quoted={quotedOf(m, byId)}
            onVote={onVote}
          />
        ))}
        {pageCount > 1 ? <Pager page={clamped} pageCount={pageCount} onPage={setPage} /> : null}
      </View>
    </FadeIn>
  );
});

const TopicRow = memo(function TopicRow({
  serverId,
  topic,
  onOpen,
  onDelete,
}: {
  serverId: string;
  topic: ForumTopicSummary;
  onOpen: (sel: { serverId: string; topicId: string }) => void;
  onDelete: (topicId: string) => void;
}): ReactElement {
  const onPress = useCallback(
    () => onOpen({ serverId, topicId: topic.id }),
    [onOpen, serverId, topic.id],
  );
  const [confirm, setConfirm] = useState(false);
  const onDeletePress = useCallback(() => {
    if (confirm) {
      onDelete(topic.id);
    } else {
      setConfirm(true);
    }
  }, [confirm, onDelete, topic.id]);
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
      <Pressable
        onPress={onDeletePress}
        hitSlop={8}
        style={[styles.deleteBtn, confirm ? styles.deleteBtnConfirm : null]}
        testID={`forum-delete-${topic.id}`}
      >
        <Text style={[styles.deleteBtnText, confirm ? { color: C.red } : null]}>
          {confirm ? "Confirm" : "🗑"}
        </Text>
      </Pressable>
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
  const { posts, activity } = useMemo(() => {
    const p: ForumMessage[] = [];
    const a: ForumMessage[] = [];
    for (const m of topic?.messages ?? []) (isDiscussion(m) ? p : a).push(m);
    return { posts: p, activity: a };
  }, [topic]);
  const [tab, setTab] = useState<"thread" | "board">("thread");
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);

  const onVote = useCallback(
    (messageId: string, direction: "up" | "down" | "clear") => {
      void client?.forumVote(topicId, messageId, direction).catch(NOOP);
    },
    [client, topicId],
  );

  const openTask = topic?.tasks.find((t) => t.id === openTaskId) ?? null;
  const closeTask = useCallback(() => setOpenTaskId(null), []);

  return (
    <View style={styles.threadRoot}>
      <View style={styles.threadBar}>
        <Pressable onPress={onBack} testID="forum-back">
          <Text style={styles.backText}>‹ Forum index</Text>
        </Pressable>
        {topic ? <PhaseChip status={topic.status} /> : null}
      </View>
      {!topic ? (
        <ThreadSkeleton />
      ) : (
        <ScrollView contentContainerStyle={styles.threadBody}>
          <Text style={styles.postTitle}>{topic.title}</Text>
          <PhaseBar status={topic.status} />
          <TabBar tab={tab} onTab={setTab} boardCount={topic.tasks.length} />
          {tab === "thread" ? (
            <FadeIn key="thread">
              <View style={styles.threadStack}>
                {topic.pendingHumanQuestion ? (
                  <View style={styles.askBanner}>
                    <Text style={styles.askBannerTitle}>
                      ⚠ {topic.pendingHumanQuestion.askedByLabel} needs your answer
                    </Text>
                    <Text style={styles.askBannerText}>{topic.pendingHumanQuestion.text}</Text>
                    <Text style={styles.askBannerHint}>
                      Answer it in the agent chat — your reply posts back here automatically.
                    </Text>
                  </View>
                ) : null}
                {posts[0] ? (
                  <PostCard
                    message={posts[0]}
                    index={1}
                    quoted={quotedOf(posts[0], byId)}
                    onVote={onVote}
                  />
                ) : null}
                <ActivitySection activity={activity} />
                <DiscussionPosts
                  posts={posts.slice(1)}
                  byId={byId}
                  onVote={onVote}
                  startIndex={2}
                />
              </View>
            </FadeIn>
          ) : (
            <FadeIn key="board">
              <KanbanBoard tasks={topic.tasks} onOpenTask={setOpenTaskId} />
            </FadeIn>
          )}
        </ScrollView>
      )}
      <TaskDetailModal task={openTask} onClose={closeTask} />
    </View>
  );
});

// Separately-paginated activity/status stream (task moves, role reviews, system notes), placed below
// the discussion posts — it isn't discussion, so it lives in its own compact section.
const ActivitySection = memo(function ActivitySection({
  activity,
}: {
  activity: ForumMessage[];
}): ReactElement | null {
  const [page, setPage] = useState(0);
  if (activity.length === 0) return null;
  const pageCount = Math.max(1, Math.ceil(activity.length / ACTIVITY_PER_PAGE));
  const clamped = Math.min(page, pageCount - 1);
  const items = activity.slice(clamped * ACTIVITY_PER_PAGE, (clamped + 1) * ACTIVITY_PER_PAGE);
  return (
    <View style={styles.activitySection}>
      <Text style={styles.activityHeader}>ACTIVITY · {activity.length}</Text>
      {items.map((m) => (
        <ActivityRow key={m.id} message={m} />
      ))}
      {pageCount > 1 ? <Pager page={clamped} pageCount={pageCount} onPage={setPage} /> : null}
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

// Markdown for forum posts / task descriptions / comments: fenced + inline code, quotes, links,
// images, bold — styled to the dark clawskills palette. (react-native-markdown-display over markdown-it.)
const MD_STYLES = {
  body: { color: C.text, fontFamily: FONT_SANS, fontSize: 13, lineHeight: 22 },
  paragraph: { marginTop: 0, marginBottom: 8 },
  strong: { color: C.text, fontWeight: "700" as const },
  em: { fontStyle: "italic" as const },
  link: { color: "#4a9df0", textDecorationLine: "underline" as const },
  code_inline: {
    // On-brand with the clawskills green accent: soft green mono on a faint green-tinted panel — reads
    // clearly as code without the amber glare, and roomier line-height keeps chips from overlapping.
    backgroundColor: "#16211a",
    color: "#7ee787",
    fontFamily: FONT_MONO,
    fontSize: 12,
    borderRadius: 4,
    borderWidth: 0,
  },
  fence: {
    backgroundColor: "#0b0b0b",
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginVertical: 6,
    color: "#d4d4d4",
    fontFamily: FONT_MONO,
    fontSize: 12,
    lineHeight: 18,
  },
  code_block: {
    backgroundColor: "#0b0b0b",
    borderColor: C.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginVertical: 6,
    color: "#d4d4d4",
    fontFamily: FONT_MONO,
    fontSize: 12,
    lineHeight: 18,
  },
  blockquote: {
    backgroundColor: C.cardAlt,
    borderLeftColor: C.green,
    borderLeftWidth: 3,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginBottom: 8,
    color: C.soft,
  },
  bullet_list: { marginBottom: 8 },
  ordered_list: { marginBottom: 8 },
  heading1: { color: C.text, fontSize: 18, fontWeight: "700" as const, marginBottom: 6 },
  heading2: { color: C.text, fontSize: 16, fontWeight: "700" as const, marginBottom: 6 },
  heading3: { color: C.text, fontSize: 14, fontWeight: "700" as const, marginBottom: 4 },
  hr: { backgroundColor: C.border, height: 1, marginVertical: 8 },
  image: { borderRadius: 6, marginVertical: 6 },
};
// A clean code block: monospace on a flat dark panel, horizontally scrollable so long lines never
// wrap/overlap, with a thin top bar. Used to override the markdown lib's default fence rendering.
const CodeBlock = memo(function CodeBlock({
  content,
  lang,
}: {
  content: string;
  lang?: string;
}): ReactElement {
  return (
    <View style={styles.codeBlock}>
      <View style={styles.codeBar}>
        <Text style={styles.codeLang}>{lang || "code"}</Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.codeScroll}
      >
        <Text style={styles.codeText}>{content.replace(/\n$/, "")}</Text>
      </ScrollView>
    </View>
  );
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- markdown-it node type isn't exported
const renderCode = (node: any): ReactElement => (
  <CodeBlock
    key={node.key}
    content={String(node.content ?? "")}
    lang={node.sourceInfo || undefined}
  />
);
const MD_RULES = { fence: renderCode, code_block: renderCode };

const ForumMarkdown = memo(function ForumMarkdown({ text }: { text: string }): ReactElement {
  return (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- lib style/rules maps aren't typed
    <Markdown style={MD_STYLES as any} rules={MD_RULES as any}>
      {text}
    </Markdown>
  );
});

// vBulletin-style reaction footer: a rounded pill with up/down thumbs and the running reputation
// score, plus the reactor count. Agents vote via tools; the human clicks here (forum/vote).
const VoteBar = memo(function VoteBar({
  message,
  onVote,
}: {
  message: ForumMessage;
  onVote: (messageId: string, direction: "up" | "down" | "clear") => void;
}): ReactElement {
  const ups = message.upvoters.length;
  const downs = message.downvoters.length;
  const score = ups - downs;
  const mine = myVote(message);
  const up = useCallback(
    () => onVote(message.id, mine === "up" ? "clear" : "up"),
    [message.id, mine, onVote],
  );
  const down = useCallback(
    () => onVote(message.id, mine === "down" ? "clear" : "down"),
    [message.id, mine, onVote],
  );
  const scoreColor = scoreColorOf(score);
  return (
    <View style={styles.voteFooter}>
      <Pressable
        onPress={up}
        style={[styles.voteBtn, mine === "up" ? styles.voteBtnUpOn : null]}
        hitSlop={4}
      >
        <Text style={[styles.voteBtnText, mine === "up" ? { color: C.green } : null]}>
          👍 {ups}
        </Text>
      </Pressable>
      <Pressable
        onPress={down}
        style={[styles.voteBtn, mine === "down" ? styles.voteBtnDownOn : null]}
        hitSlop={4}
      >
        <Text style={[styles.voteBtnText, mine === "down" ? { color: C.red } : null]}>
          👎 {downs}
        </Text>
      </Pressable>
      <View style={styles.repPill}>
        <Text style={styles.repLabel}>rep</Text>
        <Text style={[styles.repScore, { color: scoreColor }]}>
          {score > 0 ? `+${score}` : score}
        </Text>
      </View>
    </View>
  );
});

const PostCard = memo(function PostCard({
  message,
  index,
  quoted,
  onVote,
}: {
  message: ForumMessage;
  index: number;
  quoted: ForumMessage | null;
  onVote: (messageId: string, direction: "up" | "down" | "clear") => void;
}): ReactElement {
  const role = message.role;
  const color = roleColor(role);
  return (
    <View style={[styles.post, message.awaitingHuman ? styles.postAwaiting : null]}>
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
          {message.awaitingHuman ? <Text style={styles.awaitTag}>NEEDS YOUR ANSWER</Text> : null}
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
          <ForumMarkdown text={message.text} />
        </View>
        <VoteBar message={message} onVote={onVote} />
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

const EpicChip = memo(function EpicChip({
  epic,
  active,
  onToggle,
}: {
  epic: { name: string; done: number; total: number };
  active: boolean;
  onToggle: (name: string | null) => void;
}): ReactElement {
  const press = useCallback(
    () => onToggle(active ? null : epic.name),
    [active, epic.name, onToggle],
  );
  return (
    <Pressable style={[styles.epicChip, active ? styles.epicChipOn : null]} onPress={press}>
      <Text style={styles.epicChipText}>{epic.name}</Text>
      <Text style={styles.epicChipCount}>
        {epic.done}/{epic.total}
      </Text>
    </Pressable>
  );
});

const KanbanCard = memo(function KanbanCard({
  task,
  onOpen,
}: {
  task: ForumTask;
  onOpen: (taskId: string) => void;
}): ReactElement {
  const press = useCallback(() => onOpen(task.id), [onOpen, task.id]);
  const who =
    task.assigneeLabel ?? (task.assigneeAgentId ? task.assigneeAgentId.slice(0, 8) : null);
  const reopen = reopenInfo(task);
  return (
    <Pressable style={styles.kanbanCard} onPress={press} testID={`forum-task-${task.id}`}>
      <View style={[styles.cardStripe, { backgroundColor: taskDotColor(task.status) }]} />
      <View style={styles.cardTagRow}>
        {task.epic ? <Text style={styles.cardEpic}>{task.epic.toUpperCase()}</Text> : null}
        {reopen.count > 0 ? (
          <Text style={styles.reopenBadge}>↩ RE-OPENED ×{reopen.count}</Text>
        ) : null}
      </View>
      <Text style={styles.kanbanCardTitle} numberOfLines={3}>
        {task.parentTaskId ? "↳ " : ""}
        {task.title}
      </Text>
      <Text style={styles.kanbanCardMeta}>
        {estimateLabel(task.estimate)}
        {who ? ` · ${who}` : " · unassigned"}
        {task.comments.length > 0 ? ` · 💬 ${task.comments.length}` : ""}
      </Text>
    </Pressable>
  );
});

const KanbanBoard = memo(function KanbanBoard({
  tasks,
  onOpenTask,
}: {
  tasks: ForumTask[];
  onOpenTask: (taskId: string) => void;
}): ReactElement {
  const [epicFilter, setEpicFilter] = useState<string | null>(null);
  if (tasks.length === 0) {
    return (
      <Text style={styles.emptyBoard}>
        No tasks yet — the team is still discussing. Tasks appear here once they agree a plan.
      </Text>
    );
  }
  const epics = epicSummaries(tasks);
  const shown = epicFilter ? tasks.filter((t) => t.epic === epicFilter) : tasks;
  return (
    <View style={styles.boardWrap}>
      {epics.length > 0 ? (
        <View style={styles.epicStrip}>
          <Text style={styles.chartTitle}>EPICS</Text>
          <View style={styles.epicChipRow}>
            {epics.map((e) => (
              <EpicChip
                key={e.name}
                epic={e}
                active={epicFilter === e.name}
                onToggle={setEpicFilter}
              />
            ))}
          </View>
        </View>
      ) : null}
      <View style={styles.kanbanRow}>
        {KANBAN.map((col) => {
          const colTasks = shown.filter((t) => t.status === col.status);
          return (
            <View key={col.status} style={styles.column}>
              <Text style={styles.columnHead}>
                {col.label.toUpperCase()} · {colTasks.length}
              </Text>
              {colTasks.map((task) => (
                <KanbanCard key={task.id} task={task} onOpen={onOpenTask} />
              ))}
            </View>
          );
        })}
      </View>
    </View>
  );
});

// Jira-style task detail: title, status, epic, assignee, reporter, estimate, Markdown description,
// and the task's comment thread. Opened by tapping a board card.
const TaskDetailModal = memo(function TaskDetailModal({
  task,
  onClose,
}: {
  task: ForumTask | null;
  onClose: () => void;
}): ReactElement | null {
  if (!task) return null;
  const who = task.assigneeLabel ?? (task.assigneeAgentId ? task.assigneeAgentId.slice(0, 8) : "—");
  const reporter = task.createdByLabel ?? task.createdBy.slice(0, 8);
  const reopen = reopenInfo(task);
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={NOOP}>
          <View style={styles.modalHead}>
            <View style={[styles.cardStripe, { backgroundColor: taskDotColor(task.status) }]} />
            <Text style={styles.modalTitle}>
              {task.parentTaskId ? "↳ " : ""}
              {task.title}
            </Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <Text style={styles.modalClose}>✕</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.modalBody}>
            <View style={styles.metaGrid}>
              <TaskMeta
                label="Status"
                value={statusLabel(task.status)}
                color={taskDotColor(task.status)}
              />
              <TaskMeta label="Epic" value={task.epic ?? "—"} />
              <TaskMeta label="Assignee" value={who} />
              <TaskMeta label="Reporter" value={reporter} />
              <TaskMeta label="Estimate" value={estimateLabel(task.estimate)} />
              {reopen.count > 0 ? (
                <TaskMeta label="Re-opened" value={`×${reopen.count}`} color={C.amber} />
              ) : null}
            </View>
            {reopen.count > 0 ? (
              <>
                <Text style={styles.modalSection}>RE-OPENS · {reopen.count}</Text>
                {reopen.reasons.map((r) => (
                  <Text key={r.at_ms} style={styles.reopenReason}>
                    ↩ {r.note} · {timeAgo(r.at_ms)}
                  </Text>
                ))}
              </>
            ) : null}
            <Text style={styles.modalSection}>DESCRIPTION</Text>
            {task.description.trim() ? (
              <ForumMarkdown text={task.description} />
            ) : (
              <Text style={styles.modalMuted}>No description.</Text>
            )}
            <Text style={styles.modalSection}>COMMENTS · {task.comments.length}</Text>
            {task.comments.length === 0 ? (
              <Text style={styles.modalMuted}>No comments yet.</Text>
            ) : (
              task.comments.map((c) => <TaskCommentRow key={c.id} comment={c} />)
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
});

const TaskMeta = memo(function TaskMeta({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}): ReactElement {
  return (
    <View style={styles.metaCell}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={[styles.metaValue, color ? { color } : null]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
});

const TaskCommentRow = memo(function TaskCommentRow({
  comment,
}: {
  comment: ForumTaskComment;
}): ReactElement {
  const color = roleColor(comment.role);
  return (
    <View style={styles.commentRow}>
      <View style={styles.commentHead}>
        <View style={[styles.commentDot, { backgroundColor: color }]} />
        <Text style={styles.commentWho}>{comment.authorLabel}</Text>
        <Text style={styles.commentTime}>{timeAgo(comment.createdAt_ms)}</Text>
      </View>
      <ForumMarkdown text={comment.text} />
    </View>
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
  statsRow: { flexDirection: "row", flexWrap: "wrap", rowGap: 12, gap: { xs: 16, md: 32 } },
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
  threadStack: { gap: 12 },
  postStack: { gap: 12 },
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
    width: { xs: 68, md: 116 },
    alignItems: "center",
    gap: 6,
    paddingVertical: { xs: 10, md: 14 },
    paddingHorizontal: { xs: 6, md: 8 },
    backgroundColor: C.cardAlt,
    borderRightWidth: 1,
    borderRightColor: C.border,
  },
  avatar: {
    alignItems: "center",
    justifyContent: "center",
    width: { xs: 34, md: 44 },
    height: { xs: 34, md: 44 },
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
    flexWrap: "wrap",
    rowGap: 4,
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
  // Wrap so all six columns (incl. Done) stay visible; each column flexes to share the width.
  kanbanRow: { flexDirection: "row", flexWrap: "wrap", gap: 10, paddingBottom: 8 },
  column: {
    flexGrow: 1,
    // Phone: one status per row (full width) so cards stay readable; desktop: 6 columns share width.
    flexBasis: { xs: "100%", md: 150 },
    minWidth: { xs: 0, md: 140 },
    gap: 8,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.borderSoft,
    borderRadius: 8,
    padding: 8,
  },
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
  cardTagRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 },
  cardEpic: {
    fontFamily: FONT_MONO,
    letterSpacing: 0.5,
    color: C.amber,
    fontSize: 9,
    fontWeight: "700",
  },
  reopenBadge: {
    fontFamily: FONT_MONO,
    letterSpacing: 0.5,
    color: "#e04a3a",
    fontSize: 9,
    fontWeight: "700",
  },
  reopenReason: { color: C.soft, fontSize: 12, fontFamily: FONT_SANS, lineHeight: 18 },
  // dashboard
  dashboard: {
    gap: 12,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 10,
    backgroundColor: C.surface,
    padding: 16,
  },
  dashLabel: { fontFamily: FONT_MONO, letterSpacing: 0.5, color: C.muted, fontSize: 11 },
  chartsRow: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  chartCard: {
    gap: 12,
    flexGrow: 1,
    flexBasis: 300,
    borderWidth: 1,
    borderColor: C.borderSoft,
    borderRadius: 10,
    backgroundColor: C.card,
    padding: 16,
  },
  chartTitle: { fontFamily: FONT_MONO, letterSpacing: 0.5, color: C.muted, fontSize: 11 },
  donutRow: {
    flexDirection: { xs: "column", md: "row" },
    alignItems: "center",
    gap: { xs: 12, md: 20 },
  },
  legend: { alignSelf: "stretch", flexShrink: 1, gap: 7 },
  legendRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  legendDot: { width: 10, height: 10, borderRadius: 3 },
  legendLabel: { flex: 1, color: C.soft, fontSize: 12, fontFamily: FONT_SANS },
  legendN: { fontFamily: FONT_MONO, color: C.text, fontSize: 12 },
  epicChipRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  epicChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: C.card,
  },
  epicChipText: { fontFamily: FONT_MONO, letterSpacing: 0.5, color: C.amber, fontSize: 11 },
  epicChipCount: { fontFamily: FONT_MONO, color: C.muted, fontSize: 11 },
  // pager
  pager: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    paddingVertical: 10,
  },
  pagerBtn: { paddingVertical: 6, paddingHorizontal: 10 },
  pagerTxt: { fontFamily: FONT_MONO, color: C.text, fontSize: 12 },
  pagerTxtOff: { color: C.faint },
  pagerInfo: { fontFamily: FONT_MONO, color: C.muted, fontSize: 12 },
  // board wrap + epic strip
  boardWrap: { gap: 12 },
  epicStrip: { gap: 6 },
  epicChipOn: { borderColor: C.amber, backgroundColor: "#241f10" },
  // delete topic (human management)
  deleteBtn: {
    borderWidth: 1,
    borderColor: C.borderSoft,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  deleteBtnConfirm: { borderColor: C.red, backgroundColor: "#2a1212" },
  deleteBtnText: { fontFamily: FONT_MONO, color: C.muted, fontSize: 12 },
  // code block (custom markdown renderer)
  codeBlock: {
    borderWidth: 1,
    borderColor: C.borderSoft,
    borderRadius: 8,
    backgroundColor: "#0d0d0d",
    marginVertical: 6,
    overflow: "hidden",
  },
  codeBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 3,
    backgroundColor: "#0d0d0d",
  },
  codeLang: {
    fontFamily: FONT_MONO,
    letterSpacing: 1,
    color: C.faint,
    fontSize: 9,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  codeScroll: { paddingHorizontal: 12, paddingBottom: 10, paddingTop: 2 },
  codeText: { fontFamily: FONT_MONO, color: "#cfd6dd", fontSize: 12, lineHeight: 18 },
  // activity section (separate from discussion posts)
  activitySection: {
    gap: 2,
    borderWidth: 1,
    borderColor: C.borderSoft,
    borderRadius: 10,
    backgroundColor: C.surface,
    padding: 10,
  },
  activityHeader: {
    fontFamily: FONT_MONO,
    letterSpacing: 0.5,
    color: C.muted,
    fontSize: 11,
    fontWeight: "700",
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  askBannerHint: { color: C.muted, fontSize: 11, fontFamily: FONT_SANS, fontStyle: "italic" },
  // skeleton loading
  skeletonPost: { flexDirection: "row", gap: 12, paddingVertical: 10 },
  skeletonBody: { flex: 1, gap: 8 },
  // vote footer (vBulletin reactions)
  voteFooter: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: C.borderSoft,
  },
  voteBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: C.card,
  },
  voteBtnUpOn: { borderColor: C.green, backgroundColor: "#12240f" },
  voteBtnDownOn: { borderColor: C.red, backgroundColor: "#2a1212" },
  voteBtnText: { fontFamily: FONT_MONO, color: C.soft, fontSize: 12 },
  repPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginLeft: "auto",
    borderWidth: 1,
    borderColor: C.borderSoft,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  repLabel: {
    fontFamily: FONT_MONO,
    letterSpacing: 0.5,
    color: C.faint,
    fontSize: 10,
    textTransform: "uppercase",
  },
  repScore: { fontFamily: FONT_MONO, fontSize: 12, fontWeight: "700" },
  // activity rows (status/review/system — not discussion posts)
  activityRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderLeftWidth: 2,
    borderLeftColor: C.borderSoft,
  },
  activityDot: { width: 7, height: 7, borderRadius: 4 },
  activityText: { flex: 1, color: C.muted, fontSize: 12, fontFamily: FONT_SANS, lineHeight: 17 },
  activityWho: { color: C.soft, fontFamily: FONT_MONO, fontSize: 11 },
  activityKind: { color: C.faint, fontFamily: FONT_MONO, fontSize: 11 },
  activityTime: { color: C.faint, fontFamily: FONT_MONO, fontSize: 10 },
  // ask-human banner
  askBanner: {
    borderWidth: 1,
    borderColor: C.amber,
    backgroundColor: "#241f10",
    borderRadius: 8,
    padding: 12,
    gap: 4,
  },
  askBannerTitle: { color: C.amber, fontFamily: FONT_MONO, fontSize: 12, fontWeight: "700" },
  askBannerText: { color: C.text, fontSize: 13, fontFamily: FONT_SANS, lineHeight: 19 },
  // human reply composer
  replyBox: {
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 8,
    backgroundColor: C.card,
    padding: 8,
    gap: 8,
  },
  replyInput: {
    color: C.text,
    fontSize: 13,
    fontFamily: FONT_SANS,
    minHeight: 44,
    padding: 6,
  },
  replySend: {
    alignSelf: "flex-end",
    borderWidth: 1,
    borderColor: C.green,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: "#12240f",
  },
  replySendText: { color: C.green, fontFamily: FONT_MONO, fontSize: 12, fontWeight: "700" },
  // post awaiting-human highlight + tag
  postAwaiting: { borderColor: C.amber },
  awaitTag: {
    fontFamily: FONT_MONO,
    letterSpacing: 0.5,
    color: C.amber,
    fontSize: 9,
    fontWeight: "700",
    borderWidth: 1,
    borderColor: C.amber,
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  // task detail modal (Jira)
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
    justifyContent: { xs: "flex-end", md: "center" },
    padding: { xs: 8, md: 24 },
  },
  modalCard: {
    width: "100%",
    maxWidth: 680,
    maxHeight: { xs: "92%", md: "86%" },
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 12,
    backgroundColor: C.surface,
    overflow: "hidden",
  },
  modalHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  modalTitle: { flex: 1, color: C.text, fontSize: 16, fontWeight: "700", fontFamily: FONT_SANS },
  modalClose: { color: C.muted, fontSize: 18, paddingHorizontal: 4 },
  modalBody: { padding: 16, gap: 10 },
  modalSection: {
    fontFamily: FONT_MONO,
    letterSpacing: 0.5,
    color: C.muted,
    fontSize: 11,
    fontWeight: "700",
    marginTop: 6,
  },
  modalMuted: { color: C.faint, fontSize: 13, fontFamily: FONT_SANS },
  metaGrid: { flexDirection: "row", flexWrap: "wrap", gap: 16 },
  metaCell: { minWidth: 96, gap: 2 },
  metaLabel: {
    fontFamily: FONT_MONO,
    letterSpacing: 0.5,
    color: C.faint,
    fontSize: 10,
    textTransform: "uppercase",
  },
  metaValue: { color: C.text, fontSize: 13, fontFamily: FONT_MONO },
  commentRow: {
    gap: 4,
    borderTopWidth: 1,
    borderTopColor: C.borderSoft,
    paddingTop: 8,
  },
  commentHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  commentDot: { width: 8, height: 8, borderRadius: 4 },
  commentWho: { color: C.soft, fontFamily: FONT_MONO, fontSize: 12 },
  commentTime: { color: C.faint, fontFamily: FONT_MONO, fontSize: 10, marginLeft: "auto" },
}));
