import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ScrollView } from "@/components/ui/scroll-view";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import type { CommentsPanelProps } from "@/figma/contracts";
import type { FigmaComment } from "@jagentdesk/protocol/figma/rpc-schemas";

import { callFigma, errorMessage, figmaKeys } from "@/figma/prototype/figma-api";
import { formatRelativeTime } from "@/figma/versions/versions-model";
import { buildThreads, filterThreadsByNode, toggleReaction, type CommentThread } from "./threading";

// Comments panel (spec 32.5.4): threads from `figma.file.comments.list`, an "On this node"
// filter over the canvas selection, posting/replying anchored to the selected node, reaction
// chips, and deletion of your own comments. Row clicks hand the node id to the canvas via
// onFocusNode — the panel never pans the canvas itself.

const REACTION_CHOICES = [":+1:", ":tada:", ":fire:", ":eyes:"] as const;

const styles = StyleSheet.create((theme: Theme) => ({
  screen: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[2],
  },
  title: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  filterRow: { flexDirection: "row", gap: theme.spacing[1] },
  filterChip: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  filterChipActive: { borderColor: theme.colors.accent, backgroundColor: theme.colors.surface1 },
  filterLabel: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  filterLabelActive: { color: theme.colors.foreground },
  body: { flex: 1, minHeight: 0, paddingHorizontal: theme.spacing[4] },
  threadCard: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
    marginBottom: theme.spacing[3],
  },
  authorRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  avatar: {
    width: 20,
    height: 20,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surfaceWorkspace,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  authorName: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  timestamp: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  resolvedChip: { fontSize: theme.fontSize.xs, color: theme.colors.accent },
  message: { fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  messageColumn: { flex: 1, minWidth: 0, gap: 2 },
  replyBlock: {
    marginLeft: theme.spacing[3],
    paddingLeft: theme.spacing[2],
    borderLeftWidth: theme.borderWidth[1],
    borderLeftColor: theme.colors.border,
    gap: theme.spacing[2],
  },
  reactionRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[1] },
  reactionChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  reactionChipMine: { borderColor: theme.colors.accent },
  reactionText: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  actionRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  linkButton: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  composer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  input: {
    flex: 1,
    minHeight: 34,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", gap: theme.spacing[3] },
  centerSmall: { alignItems: "center", paddingVertical: theme.spacing[6], gap: theme.spacing[3] },
  muted: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  spinner: { color: theme.colors.foregroundMuted },
  placeholderColor: { color: theme.colors.foregroundMuted },
  rightColumn: { gap: theme.spacing[1] },
}));

export function CommentsPanel({ file, selection, onFocusNode }: CommentsPanelProps) {
  const client = useHostRuntimeClient(file.serverId);
  const queryClient = useQueryClient();
  const [onThisNode, setOnThisNode] = useState(false);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const commentsRequest = useFetchQuery<FigmaComment[]>({
    queryKey: figmaKeys.comments(file.serverId, file.fileKey, file.version ?? null),
    queryFn: async () => {
      const data = await callFigma(client, "figma.file.comments.list.request", {
        fileKey: file.fileKey,
      });
      return data.comments;
    },
    enabled: client !== null,
    dataShape: "list",
    staleTimeMs: 60_000,
  });
  const comments = useMemo(() => commentsRequest.data ?? [], [commentsRequest.data]);
  const now_ms = Date.now();

  const threads = useMemo(
    () =>
      onThisNode
        ? filterThreadsByNode(buildThreads(comments), selection.nodeId)
        : buildThreads(comments),
    [comments, onThisNode, selection.nodeId],
  );

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: figmaKeys.comments(file.serverId, file.fileKey, file.version ?? null),
    });
  }, [queryClient, file.serverId, file.fileKey, file.version]);

  const run = useCallback(
    async (task: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await task();
        invalidate();
      } finally {
        setBusy(false);
      }
    },
    [invalidate],
  );

  const post = useCallback(() => {
    const message = draft.trim();
    if (!message) return;
    setDraft("");
    void run(() =>
      callFigma(client, "figma.file.comments.post.request", {
        fileKey: file.fileKey,
        message,
        nodeId: selection.nodeId ?? undefined,
      }),
    );
  }, [draft, client, file.fileKey, selection.nodeId, run]);

  const postReply = useCallback(
    (threadId: string) => {
      const message = replyDraft.trim();
      if (!message) return;
      setReplyDraft("");
      setReplyTo(null);
      void run(() =>
        callFigma(client, "figma.file.comments.post.request", {
          fileKey: file.fileKey,
          message,
          parentId: threadId,
        }),
      );
    },
    [replyDraft, client, file.fileKey, run],
  );

  const react = useCallback(
    (comment: FigmaComment, emoji: string) => {
      const existing = comment.reactions.find((reaction) => reaction.emoji === emoji);
      void run(() =>
        callFigma(client, "figma.file.comments.react.request", {
          fileKey: file.fileKey,
          commentId: comment.id,
          emoji,
          remove: Boolean(existing?.mine),
        }),
      );
    },
    [client, file.fileKey, run],
  );

  const remove = useCallback(
    (commentId: string) => {
      void run(() =>
        callFigma(client, "figma.file.comments.delete.request", {
          fileKey: file.fileKey,
          commentId,
        }),
      );
    },
    [client, file.fileKey, run],
  );

  const toggleReply = useCallback((threadId: string) => {
    setReplyTo((current) => (current === threadId ? null : threadId));
    setReplyDraft("");
  }, []);

  const retry = useCallback(() => {
    void commentsRequest.refetch();
  }, [commentsRequest]);

  const showAll = useCallback(() => {
    setOnThisNode(false);
  }, []);
  const showOnNode = useCallback(() => {
    setOnThisNode(true);
  }, []);

  if (commentsRequest.error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>{errorMessage(commentsRequest.error)}</Text>
        <Button variant="outline" size="sm" onPress={retry}>
          Retry
        </Button>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>Comments</Text>
        <View style={styles.filterRow}>
          <FilterChip label="All" active={!onThisNode} onPress={showAll} />
          <FilterChip
            label="On this node"
            active={onThisNode}
            disabled={!selection.nodeId}
            onPress={showOnNode}
          />
        </View>
      </View>

      <CommentsBody
        pending={commentsRequest.isPending}
        threads={threads}
        onThisNode={onThisNode}
        now_ms={now_ms}
        replyTo={replyTo}
        replyDraft={replyDraft}
        busy={busy}
        onReplyDraft={setReplyDraft}
        onToggleReply={toggleReply}
        onSubmitReply={postReply}
        onFocusNode={onFocusNode}
        onReact={react}
        onDelete={remove}
      />

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder={selection.nodeId ? "Comment on the selected node…" : "Add a comment…"}
          placeholderTextColor={styles.placeholderColor.color}
          submitBehavior="newline"
          onSubmitEditing={post}
          testID="figma-comment-input"
        />
        <Button size="sm" onPress={post} disabled={busy || draft.trim().length === 0}>
          Post
        </Button>
      </View>
    </View>
  );
}

function FilterChip({
  label,
  active,
  disabled,
  onPress,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={[styles.filterChip, active && styles.filterChipActive]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
    >
      <Text style={[styles.filterLabel, active && styles.filterLabelActive]}>{label}</Text>
    </Pressable>
  );
}

interface CommentsBodyProps {
  pending: boolean;
  threads: readonly CommentThread[];
  onThisNode: boolean;
  now_ms: number;
  replyTo: string | null;
  replyDraft: string;
  busy: boolean;
  onReplyDraft: (value: string) => void;
  onToggleReply: (threadId: string) => void;
  onSubmitReply: (threadId: string) => void;
  onFocusNode: (nodeId: string) => void;
  onReact: (comment: FigmaComment, emoji: string) => void;
  onDelete: (commentId: string) => void;
}

function CommentsBody(props: CommentsBodyProps) {
  if (props.pending) {
    return (
      <View style={styles.body}>
        <View style={styles.centerSmall}>
          <LoadingSpinner size="small" color={styles.spinner.color} />
        </View>
      </View>
    );
  }
  if (props.threads.length === 0) {
    return (
      <View style={styles.body}>
        <View style={styles.centerSmall}>
          <Text style={styles.muted}>
            {props.onThisNode ? "No comments on this node." : "No comments yet."}
          </Text>
        </View>
      </View>
    );
  }
  return (
    <ScrollView style={styles.body} testID="figma-comments-list">
      {props.threads.map((thread) => (
        <ThreadCard
          key={thread.root.id}
          thread={thread}
          now_ms={props.now_ms}
          replying={props.replyTo === thread.root.id}
          replyDraft={props.replyDraft}
          busy={props.busy}
          onReplyDraft={props.onReplyDraft}
          onToggleReply={props.onToggleReply}
          onSubmitReply={props.onSubmitReply}
          onFocusNode={props.onFocusNode}
          onReact={props.onReact}
          onDelete={props.onDelete}
        />
      ))}
    </ScrollView>
  );
}

interface ThreadCardProps {
  thread: CommentThread;
  now_ms: number;
  replying: boolean;
  replyDraft: string;
  busy: boolean;
  onReplyDraft: (value: string) => void;
  onToggleReply: (threadId: string) => void;
  onSubmitReply: (threadId: string) => void;
  onFocusNode: (nodeId: string) => void;
  onReact: (comment: FigmaComment, emoji: string) => void;
  onDelete: (commentId: string) => void;
}

function ThreadCard({
  thread,
  now_ms,
  replying,
  replyDraft,
  busy,
  onReplyDraft,
  onToggleReply,
  onSubmitReply,
  onFocusNode,
  onReact,
  onDelete,
}: ThreadCardProps) {
  const rootId = thread.root.id;
  const openReply = useCallback(() => onToggleReply(rootId), [onToggleReply, rootId]);
  const sendReply = useCallback(() => onSubmitReply(rootId), [onSubmitReply, rootId]);
  return (
    <View style={styles.threadCard}>
      <CommentRow
        comment={thread.root}
        now_ms={now_ms}
        onFocusNode={onFocusNode}
        onReact={onReact}
        onDelete={onDelete}
      />
      {thread.resolved ? <Text style={styles.resolvedChip}>Resolved</Text> : null}
      {thread.replies.length > 0 ? (
        <View style={styles.replyBlock}>
          {thread.replies.map((reply) => (
            <CommentRow
              key={reply.id}
              comment={reply}
              now_ms={now_ms}
              onFocusNode={onFocusNode}
              onReact={onReact}
              onDelete={onDelete}
            />
          ))}
        </View>
      ) : null}
      <View style={styles.actionRow}>
        <Pressable onPress={openReply} hitSlop={6} accessibilityRole="button">
          <Text style={styles.linkButton}>Reply</Text>
        </Pressable>
      </View>
      {replying ? (
        <View style={styles.composer}>
          <TextInput
            style={styles.input}
            value={replyDraft}
            onChangeText={onReplyDraft}
            placeholder="Reply…"
            placeholderTextColor={styles.placeholderColor.color}
            onSubmitEditing={sendReply}
            testID={`figma-comment-reply-${thread.root.id}`}
          />
          <Button size="xs" onPress={sendReply} disabled={busy || replyDraft.trim().length === 0}>
            Send
          </Button>
        </View>
      ) : null}
    </View>
  );
}

function CommentRow({
  comment,
  now_ms,
  onFocusNode,
  onReact,
  onDelete,
}: {
  comment: FigmaComment;
  now_ms: number;
  onFocusNode: (nodeId: string) => void;
  onReact: (comment: FigmaComment, emoji: string) => void;
  onDelete: (commentId: string) => void;
}) {
  const handle = comment.user.handle;
  const focus = useCallback(() => {
    if (comment.nodeId) onFocusNode(comment.nodeId);
  }, [comment, onFocusNode]);
  const drop = useCallback(() => onDelete(comment.id), [comment, onDelete]);
  return (
    <View style={styles.authorRow}>
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>{initials(handle)}</Text>
      </View>
      <View style={styles.messageColumn}>
        <View style={styles.authorRow}>
          <Text style={styles.authorName}>{handle}</Text>
          <Text style={styles.timestamp}>{formatRelativeTime(comment.createdAt_ms, now_ms)}</Text>
        </View>
        <Pressable disabled={!comment.nodeId} onPress={focus} accessibilityRole="button">
          <Text style={styles.message}>{comment.message}</Text>
        </Pressable>
      </View>
      <View style={styles.rightColumn}>
        <ReactionRow comment={comment} onReact={onReact} />
        {comment.mine ? (
          <Pressable onPress={drop} hitSlop={6} accessibilityRole="button">
            <Text style={styles.linkButton}>Delete</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function ReactionRow({
  comment,
  onReact,
}: {
  comment: FigmaComment;
  onReact: (comment: FigmaComment, emoji: string) => void;
}) {
  return (
    <View style={styles.reactionRow}>
      {comment.reactions.map((reaction) => (
        <ReactionChip
          key={reaction.emoji}
          comment={comment}
          emoji={reaction.emoji}
          count={reaction.count}
          mine={reaction.mine}
          onReact={onReact}
        />
      ))}
      {REACTION_CHOICES.filter(
        (emoji) => !comment.reactions.some((reaction) => reaction.emoji === emoji),
      ).map((emoji) => (
        <ReactionChip
          key={`add-${emoji}`}
          comment={comment}
          emoji={emoji}
          count={0}
          mine={false}
          onReact={onReact}
        />
      ))}
    </View>
  );
}

function ReactionChip({
  comment,
  emoji,
  count,
  mine,
  onReact,
}: {
  comment: FigmaComment;
  emoji: string;
  count: number;
  mine: boolean;
  onReact: (comment: FigmaComment, emoji: string) => void;
}) {
  const toggle = useCallback(() => {
    // toggleReaction previews the flip locally; the list refetch confirms it.
    toggleReaction(comment, emoji);
    onReact(comment, emoji);
  }, [comment, emoji, onReact]);
  return (
    <Pressable
      style={[styles.reactionChip, mine && styles.reactionChipMine]}
      onPress={toggle}
      accessibilityRole="button"
    >
      <Text style={styles.reactionText}>
        {emoji} {count}
      </Text>
    </Pressable>
  );
}

function initials(handle: string): string {
  const parts = handle.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((part) => part[0]!.toUpperCase());
  return letters.join("") || "?";
}
