import { parseDiff } from "@/utils/diff-highlighter";
import { router, useLocalSearchParams } from "expo-router";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { useCallback } from "react";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type { Bot, BotItem, BotQuestion } from "@jagentdesk/protocol/bots/types";
import type { Review, ReviewFinding } from "@jagentdesk/protocol/review/types";
import type { ParsedDiffFile } from "@jagentdesk/protocol/messages";
import { Button } from "@/components/ui/button";
import { gumloopListStyles } from "@/components/gumloop-shell/list-styles";
import { useIsGumloopTheme } from "@/components/gumloop-shell/use-gumloop-chrome";
import { DiffViewer } from "@/components/diff-viewer";
import { ScrollableCodeSurface } from "@/components/ui/scrollable-code-surface";
import { PermissionRequestCard } from "@/agent-stream/view";
import { useSessionStore } from "@/stores/session-store";
import { useFetchQuery } from "@/data/query";
import { parseUnifiedDiff } from "@/utils/tool-call-parsers";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { useItems, useBotsConnection, useBotsMutation, botsKey } from "./queries";
import { sortItems } from "./model";
import { styles } from "./styles";
import { Section, QueryNotice, ErrorNotice, Input } from "./ui";
export function WorkerPermissions({
  serverId,
  bot,
  items,
  includeSupervisor = false,
}: {
  serverId: string;
  bot: Bot;
  items: readonly BotItem[];
  includeSupervisor?: boolean;
}) {
  const { client } = useBotsConnection(serverId);
  const agents = useSessionStore((state) => state.sessions[serverId]?.agents);
  const workerIds = useMemo(() => {
    const ids = new Set(items.flatMap((item) => item.workerAgentIds));
    if (includeSupervisor && bot.agentId) ids.add(bot.agentId);
    let changed = true;
    while (changed) {
      changed = false;
      for (const agent of agents?.values() ?? []) {
        if (agent.parentAgentId && ids.has(agent.parentAgentId) && !ids.has(agent.id)) {
          ids.add(agent.id);
          changed = true;
        }
      }
    }
    return ids;
  }, [agents, items, includeSupervisor, bot.agentId]);
  const permissions = useSessionStore(
    useShallow((state) =>
      Array.from(state.sessions[serverId]?.pendingPermissions.values() ?? []).filter((permission) =>
        workerIds.has(permission.agentId),
      ),
    ),
  );
  if (!permissions.length) return null;
  return (
    <ScrollView
      style={styles.permissions}
      contentContainerStyle={styles.card}
      testID="bots-worker-permissions"
    >
      {permissions.map((permission) => (
        <PermissionRequestCard key={permission.key} permission={permission} client={client} />
      ))}
    </ScrollView>
  );
}
function AnswerOption({
  text,
  index,
  recommended,
  pending,
  answer,
}: {
  text: string;
  index: number;
  recommended: boolean;
  pending: boolean;
  answer: (text: string) => void;
}) {
  const { t } = useTranslation();
  const press = useCallback(
    function press() {
      answer(text);
    },
    [answer, text],
  );
  return (
    <Button
      size="sm"
      variant={recommended ? "default" : "outline"}
      onPress={press}
      disabled={pending}
      testID={`bot-answer-option-${index}`}
    >
      {text}
      {recommended ? ` (${t("bots.recommended")})` : ""}
    </Button>
  );
}
function Question({
  serverId,
  item,
  question,
  index,
}: {
  serverId: string;
  item: BotItem;
  question: BotQuestion;
  index: number;
}) {
  const { t } = useTranslation();
  const answer = useBotsMutation(serverId, "bots.items.answer.request");
  const [text, setText] = useState("");
  const submit = useCallback(
    function submit(value: string) {
      answer.mutate({
        botId: item.botId,
        itemId: item.id,
        answers: [{ questionIndex: index, text: value }],
      });
    },
    [answer, item, index],
  );
  const submitText = useCallback(
    function submitText() {
      submit(text.trim());
    },
    [submit, text],
  );
  return (
    <Section title={question.text}>
      {question.answer !== undefined ? (
        <Text style={styles.text}>
          {t("bots.answered")}: {question.answer}
        </Text>
      ) : (
        <>
          <View style={styles.row}>
            {question.options.map((option, optionIndex) => (
              <AnswerOption
                key={option}
                text={option}
                index={optionIndex}
                recommended={question.recommended === optionIndex}
                pending={answer.isPending}
                answer={submit}
              />
            ))}
          </View>
          <Input label={t("bots.answerPlaceholder")} value={text} onChange={setText} />
          <Button
            onPress={submitText}
            disabled={answer.isPending || !text.trim()}
            loading={answer.isPending}
          >
            {t("bots.answer")}
          </Button>
        </>
      )}
      <ErrorNotice error={answer.error} />
    </Section>
  );
}
function WorktreeFile({
  serverId,
  cwd,
  path,
  onClose,
}: {
  serverId: string;
  cwd: string;
  path: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { client, enabled } = useBotsConnection(serverId);
  const file = useFetchQuery({
    queryKey: [...botsKey(serverId), "file", cwd, path],
    enabled,
    staleTimeMs: 1000,
    dataShape: "value",
    queryFn: async () => {
      if (!client) throw new Error(t("bots.offline"));
      const result = await client.readFile(cwd, path, undefined, 1024 * 1024);
      return new TextDecoder().decode(result.bytes);
    },
  });
  return (
    <Section title={path}>
      <Button size="sm" variant="ghost" onPress={onClose}>
        {t("bots.close")}
      </Button>
      <QueryNotice query={file} />
      {file.data !== undefined ? (
        <ScrollableCodeSurface testID="bot-worktree-file">{file.data}</ScrollableCodeSurface>
      ) : null}
    </Section>
  );
}
function DiffFileButton({
  file,
  select,
}: {
  file: Pick<ParsedDiffFile, "path" | "additions" | "deletions">;
  select: (path: string) => void;
}) {
  const open = useCallback(
    function open() {
      select(file.path);
    },
    [select, file],
  );
  return (
    <Button size="sm" variant="outline" onPress={open}>
      {file.path} · +{file.additions} −{file.deletions}
    </Button>
  );
}
function WorktreeDiff({
  serverId,
  item,
}: {
  serverId: string;
  item: BotItem & {
    worktree: string;
  };
}) {
  const { t } = useTranslation();
  const { client, enabled } = useBotsConnection(serverId);
  const [path, setPath] = useState<string | null>(null);
  const diff = useFetchQuery({
    queryKey: [...botsKey(serverId), "diff", item.id, item.updatedAt_ms],
    enabled,
    staleTimeMs: 1000,
    dataShape: "value",
    queryFn: async () => {
      if (!client) throw new Error(t("bots.offline"));
      const result = await client.getCheckoutDiff(item.worktree, {
        mode: "uncommitted",
      });
      if (result.error) throw new Error(result.error.message);
      return result.files;
    },
  });
  const files = useMemo(() => {
    const reviewed = parseDiff(item.diff ?? "");
    const byPath = new Map<string, Pick<ParsedDiffFile, "path" | "additions" | "deletions">>(
      reviewed.map((file) => [file.path, file]),
    );
    for (const file of diff.data ?? []) if (!byPath.has(file.path)) byPath.set(file.path, file);
    return Array.from(byPath.values());
  }, [item.diff, diff.data]);
  const closeFile = useCallback(
    function closeFile() {
      setPath(null);
    },
    [setPath],
  );
  return (
    <Section title={t("bots.files")}>
      <Text selectable style={styles.muted}>
        {item.worktree}
      </Text>
      <QueryNotice query={diff} />
      {files.map((file) => (
        <DiffFileButton key={file.path} file={file} select={setPath} />
      ))}
      {path ? (
        <WorktreeFile serverId={serverId} cwd={item.worktree} path={path} onClose={closeFile} />
      ) : null}
    </Section>
  );
}
function Finding({ finding }: { finding: ReviewFinding }) {
  return (
    <View>
      <Text selectable style={styles.text}>
        {finding.severity} · {finding.path}:{finding.startLine} — {finding.content}
      </Text>
      {finding.suggestion ? (
        <Text selectable style={styles.muted}>
          {finding.suggestion}
        </Text>
      ) : null}
    </View>
  );
}
function ReviewCard({ review }: { review: Review }) {
  return (
    <View style={styles.card}>
      <Text style={styles.text}>
        {review.reviewerLabel} · {review.verdict}
      </Text>
      <Text style={styles.muted}>{review.coverage}</Text>
      {review.findings.map((finding) => (
        <Finding
          key={`${finding.path}:${finding.startLine}:${finding.content}`}
          finding={finding}
        />
      ))}
    </View>
  );
}
function WorkerButton({ serverId, agentId }: { serverId: string; agentId: string }) {
  const { t } = useTranslation();
  const open = useCallback(
    function open() {
      navigateToAgent({ serverId, agentId });
    },
    [serverId, agentId],
  );
  return (
    <Button size="sm" variant="outline" onPress={open}>
      {t("bots.worker")} · {agentId.slice(0, 8)}
    </Button>
  );
}
function ItemComments({ serverId, item }: { serverId: string; item: BotItem }) {
  const { t } = useTranslation();
  const send = useBotsMutation(serverId, "bots.chat.send.request");
  const [comment, setComment] = useState("");
  const post = useCallback(
    async function post() {
      try {
        await send.mutateAsync({
          botId: item.botId,
          text: `Add this owner comment to item ${item.id}:\n${comment}`,
        });
        setComment("");
      } catch {
        /* The mutation renders the error. */
      }
    },
    [send, item, comment, setComment],
  );
  return (
    <Section title={t("bots.comments")}>
      {item.comments.map((entry) => (
        <View key={entry.id}>
          <Text style={styles.muted}>
            {entry.author} · {new Date(entry.createdAt_ms).toLocaleString()}
          </Text>
          <Text selectable style={styles.text}>
            {entry.text}
          </Text>
        </View>
      ))}
      <Input label={t("bots.comment")} value={comment} onChange={setComment} multiline />
      <Button
        size="sm"
        onPress={post}
        disabled={send.isPending || !comment.trim()}
        loading={send.isPending}
      >
        {t("bots.send")}
      </Button>
      <ErrorNotice error={send.error} />
      {send.isSuccess ? <Text style={styles.muted}>{t("bots.commentSent")}</Text> : null}
    </Section>
  );
}
function CancelItem({ serverId, item }: { serverId: string; item: BotItem }) {
  const { t } = useTranslation();
  const cancel = useBotsMutation(serverId, "bots.items.cancel.request");
  const [reason, setReason] = useState("");
  const submit = useCallback(
    function submit() {
      cancel.mutate({ botId: item.botId, itemId: item.id, reason: reason.trim() });
    },
    [cancel, item, reason],
  );
  return (
    <Section title={t("bots.cancelItem")}>
      <Input label={t("bots.reason")} value={reason} onChange={setReason} />
      <Button
        variant="destructive"
        onPress={submit}
        disabled={cancel.isPending || !reason.trim()}
        loading={cancel.isPending}
      >
        {t("bots.cancelItem")}
      </Button>
      <ErrorNotice error={cancel.error} />
    </Section>
  );
}
function ItemSummary({ summary }: { summary: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const preview = summary.split(/\n\s*\n/, 1)[0];
  const text = expanded ? summary : preview;
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  return (
    <>
      <MarkdownRenderer text={text} compact />
      {preview !== summary ? (
        <Button size="sm" variant="ghost" onPress={toggle}>
          {t(expanded ? "bots.showLess" : "bots.fullSummary")}
        </Button>
      ) : null}
    </>
  );
}
export function ItemDetail({ serverId, item }: { serverId: string; item: BotItem }) {
  const { t } = useTranslation();
  const lines = useMemo(() => parseUnifiedDiff(item.diff), [item.diff]);
  const worktreeItem = useMemo(
    () => (item.worktree ? { ...item, worktree: item.worktree } : null),
    [item],
  );
  return (
    <View style={styles.column} testID="bot-item-detail">
      <Text style={styles.title}>{item.title}</Text>
      <Text style={styles.muted}>{t(`bots.${item.status}`)}</Text>
      <Section title={t("bots.doneMeans")}>
        <Text selectable style={styles.text}>
          {item.doneMeans}
        </Text>
      </Section>
      {item.waitFor ? (
        <Section title={t("bots.waiting")}>
          <Text style={styles.text}>{item.waitFor.condition}</Text>
          <Text style={styles.muted}>
            {t("bots.waitUntil", { time: new Date(item.waitFor.until_ms).toLocaleString() })}
          </Text>
        </Section>
      ) : null}
      {item.questions?.map((question, index) => (
        <Question
          key={question.text}
          serverId={serverId}
          item={item}
          question={question}
          index={index}
        />
      ))}
      {item.summary ? (
        <Section title={t("bots.summary")}>
          <ItemSummary summary={item.summary} />
        </Section>
      ) : null}
      <Section title={t("bots.diff")}>
        {item.diff ? (
          <DiffViewer diffLines={lines} maxHeight={480} />
        ) : (
          <Text style={styles.muted}>{t("bots.noDiff")}</Text>
        )}
        {item.reviewedDiffHash ? (
          <Text selectable style={styles.muted}>
            {t("bots.reviewedHash")}: {item.reviewedDiffHash}
          </Text>
        ) : null}
      </Section>
      {worktreeItem ? <WorktreeDiff serverId={serverId} item={worktreeItem} /> : null}
      <Section title={t("bots.findings")}>
        {item.reviews.map((review) => (
          <ReviewCard key={review.id} review={review} />
        ))}
        {item.reviews.every((review) => review.findings.length === 0) ? (
          <Text style={styles.muted}>{t("bots.noFindings")}</Text>
        ) : null}
      </Section>
      <View style={styles.row}>
        {item.workerAgentIds.map((agentId) => (
          <WorkerButton key={agentId} serverId={serverId} agentId={agentId} />
        ))}
      </View>
      <ItemComments serverId={serverId} item={item} />
      {item.status !== "done" && item.status !== "canceled" ? (
        <CancelItem serverId={serverId} item={item} />
      ) : null}
    </View>
  );
}
function ItemRow({
  item,
  active,
  select,
}: {
  item: BotItem;
  active: boolean;
  select: (id: string) => void;
}) {
  const { t } = useTranslation();
  const isGumloop = useIsGumloopTheme();
  const open = useCallback(
    function open() {
      select(item.id);
    },
    [select, item],
  );
  // Gumloop lists items as 44px divided rows (spec 38 §4.6) instead of stacked buttons.
  if (isGumloop)
    return (
      <Pressable
        onPress={open}
        accessibilityRole="button"
        style={[gumloopListStyles.row, styles.itemRow, active && styles.itemRowActive]}
        testID={`bot-item-${item.id}`}
      >
        <Text style={styles.itemStatus} numberOfLines={1}>
          {t(`bots.${item.status}`)}
        </Text>
        <Text style={styles.itemTitle} numberOfLines={1}>
          {item.title}
        </Text>
      </Pressable>
    );
  return (
    <Button
      variant={active ? "secondary" : "outline"}
      onPress={open}
      testID={`bot-item-${item.id}`}
    >
      {t(`bots.${item.status}`)} · {item.title}
    </Button>
  );
}
export function BotItems({ serverId, botId }: { serverId: string; botId: string }) {
  const { t } = useTranslation();
  const query = useItems(serverId, botId);
  const isGumloop = useIsGumloopTheme();
  const [expanded, setExpanded] = useState(false);
  const params = useLocalSearchParams<{ itemId?: string }>();
  const selectedId = params.itemId;
  const setSelectedId = useCallback((itemId: string) => router.setParams({ itemId }), []);
  const items = sortItems(query.data ?? []);
  const visible = expanded ? items : items.slice(0, 5);
  const selected = items.find((item) => item.id === selectedId);
  const showMore = useCallback(
    function showMore() {
      setExpanded(true);
    },
    [setExpanded],
  );
  return (
    <ScrollView contentContainerStyle={styles.body} testID="bots-items">
      <QueryNotice query={query} />
      {query.isSuccess && !items.length ? (
        <Text style={styles.muted}>{t("bots.noItems")}</Text>
      ) : null}
      {visible.length ? (
        <View style={isGumloop ? styles.itemListFlush : styles.itemList}>
          {visible.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              active={selectedId === item.id}
              select={setSelectedId}
            />
          ))}
        </View>
      ) : null}
      {!expanded && items.length > 5 ? (
        <Button variant="ghost" onPress={showMore}>
          {t("bots.showMore", { count: items.length - 5 })}
        </Button>
      ) : null}
      {selected ? <ItemDetail key={selected.id} serverId={serverId} item={selected} /> : null}
    </ScrollView>
  );
}
