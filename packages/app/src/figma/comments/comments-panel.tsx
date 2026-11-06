import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ScrollView } from "@/components/ui/scroll-view";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { confirmDialog } from "@/utils/confirm-dialog";
import type { Theme } from "@/styles/theme";
import type { CommentsPanelProps } from "@/figma/contracts";
import type { FigmaComment } from "@jagentdesk/protocol/figma/rpc-schemas";

import { callFigma, errorMessage, figmaKeys } from "@/figma/prototype/figma-api";
import { formatRelativeTime } from "@/figma/versions/versions-model";
import { renderEmoji } from "./emoji";
import {
  applyThreadFilters,
  buildThreads,
  toggleReaction,
  type CommentThread,
  type ThreadOrder,
} from "./threading";

// Comments panel (spec 32.5.4): threads from `figma.file.comments.list`, an "On this node"
// filter over the canvas selection, posting/replying anchored to the selected node, reaction
// chips, and deletion of your own comments. Rows stack — header (avatar, name, time), full-width
// message, reactions — so the message never shares a line with the chips. Clicks hand the node
// id to the canvas via onFocusNode (the file screen turns it into a `node=` URL) and pure-offset
// pins via onFocusPoint; the panel never pans the canvas itself.
//
// Reliability contract (packet C1):
// - Every write goes through the daemon's real REST RPCs — post (with or without parentId),
//   react, delete. There is no mock product data and no claim of a live push; Refresh re-reads
//   the same query.
// - A failing action shows its error at that action (composer, reply composer, reaction row,
//   delete row) with Retry (re-runs the same captured request) and Dismiss, and nothing else:
//   no unhandled rejection, no auto-retry of an uncertain write.
// - The draft/reply text survives until the RPC confirms success, and is cleared only if the
//   user has not typed over it in the meantime.
// - A same-event-loop double press collapses to one RPC via synchronous in-flight refs (the
//   committed `busy` state alone races the second press).
// - Host/file/version identity remounts the whole inner panel via `key`, and the inner keeps an
//   unmount generation: a late settle never wipes the new draft, stamps stale busy/error, or
//   refetches the wrong list. A successful write always invalidates the key it captured.
// - Destructive deletes (own comments/threads only) confirm through the established
//   cross-platform dialog (`@/utils/confirm-dialog`): native Alert, desktop host dialog, web
//   confirm. The root form states how many replies go with it. Cancel sends zero RPC.
// - Historical versions (file.version set) are read-only: reads, filters and Refresh work, all
//   write controls are disabled.
// - Scope is reliability + existing REST capabilities (32.12 keeps mentions/notifications,
//   resolve/reopen writes, edit/move, unread): no fake resolve/edit/mention buttons.

interface ActionFailure {
  message: string;
  retry: () => void;
  dismiss: () => void;
}

type FailureMap = Record<string, ActionFailure | undefined>;
type BusyMap = Record<string, boolean>;

export function CommentsPanel(props: CommentsPanelProps) {
  // File identity = host + file + version. A switch is a different document: the inner panel
  // remounts under a new key so drafts, reply box, failures, busy state and filter state of the
  // previous file are dropped instead of racing its late results.
  const identity = `${props.file.serverId}\0${props.file.fileKey}\0${props.file.version ?? ""}`;
  return <CommentsPanelInner key={identity} {...props} />;
}

function CommentsPanelInner({ file, selection, onFocusNode, onFocusPoint }: CommentsPanelProps) {
  const client = useHostRuntimeClient(file.serverId);
  const queryClient = useQueryClient();
  const [onThisNode, setOnThisNode] = useState(false);
  const [draft, setDraft] = useState("");
  // One atom: the reply target and its text move together, so a success that clears the text
  // also closes the composer, and a draft typed over mid-flight keeps the composer open.
  const [reply, setReply] = useState<{ threadId: string; text: string } | null>(null);
  const [busy, setBusy] = useState<BusyMap>({});
  const [failures, setFailures] = useState<FailureMap>({});
  // Synchronous latches: `busy` is committed asynchronously, so the ref — not the state — is
  // what collapses a same-event-loop double press into one RPC.
  const inFlight = useRef<BusyMap>({});
  // Bumped on unmount: the keyed remount covers host/file/version switches, this covers the
  // panel being closed while a write is pending.
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true; // StrictMode/dev double-invoke re-mounts the same instance
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);
  // list controls (32.5.4): search over message + real author, activity sort, resolved
  // visibility (hidden by default, like Figma), threads involving me (real `mine` flags only).
  const [search, setSearch] = useState("");
  const [order, setOrder] = useState<ThreadOrder>("latest");
  const [showResolved, setShowResolved] = useState(false);
  const [mineOnly, setMineOnly] = useState(false);

  const readOnly = Boolean(file.version);

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

  const allThreads = useMemo(() => buildThreads(comments), [comments]);
  const visibleThreads = useMemo(
    () =>
      applyThreadFilters(allThreads, {
        query: search,
        mineOnly,
        showResolved,
        order,
        nodeId: onThisNode ? selection.nodeId : null,
      }),
    [allThreads, search, mineOnly, showResolved, order, onThisNode, selection.nodeId],
  );
  // Anything the controls actually hid (resolved default, search, mine, node scope) makes the
  // empty state read as "filtered", not "the file has no comments".
  const filtersActive =
    search.trim().length > 0 ||
    mineOnly ||
    showResolved ||
    onThisNode ||
    allThreads.length > visibleThreads.length;

  const clearFailure = useCallback((actionKey: string) => {
    setFailures((f) => (f[actionKey] === undefined ? f : { ...f, [actionKey]: undefined }));
  }, []);

  // The single path for every mutation. The captured key is this instance's comments query, so
  // invalidation always refreshes the file the write belonged to — even after unmount or a file
  // switch — while UI state (input clearing, failure banner, busy) applies only to a live
  // generation.
  const submit = useCallback(
    (actionKey: string, task: () => Promise<unknown>, onSuccess?: () => void) => {
      // An unmounted owner (panel closed) dispatches nothing further; its Retry closures are
      // dead UI, and the keyed remount already gave the new file its own instance.
      if (!mounted.current) return;
      if (inFlight.current[actionKey]) return;
      inFlight.current[actionKey] = true;
      const gen = generation.current;
      clearFailure(actionKey);
      setBusy((b) => ({ ...b, [actionKey]: true }));
      void (async () => {
        try {
          await task();
          if (generation.current === gen) onSuccess?.();
        } catch (cause) {
          if (generation.current === gen) {
            setFailures((f) => ({
              ...f,
              [actionKey]: {
                message: errorMessage(cause),
                retry: () => submit(actionKey, task, onSuccess),
                dismiss: () => clearFailure(actionKey),
              },
            }));
          }
        } finally {
          inFlight.current[actionKey] = false;
          if (generation.current === gen) {
            setBusy((b) => {
              const next = { ...b };
              delete next[actionKey];
              return next;
            });
          }
          void queryClient.invalidateQueries({
            queryKey: figmaKeys.comments(file.serverId, file.fileKey, file.version ?? null),
          });
        }
      })();
    },
    [clearFailure, queryClient, file.serverId, file.fileKey, file.version],
  );

  const post = useCallback(() => {
    if (readOnly) return;
    const raw = draft;
    const message = raw.trim();
    if (!message) return;
    submit(
      "post",
      () =>
        callFigma(client, "figma.file.comments.post.request", {
          fileKey: file.fileKey,
          message,
          nodeId: selection.nodeId ?? undefined,
        }),
      // The draft is owned by the composer until the RPC confirms; cleared only if the user has
      // not typed over it while the request was in flight.
      () => setDraft((prev) => (prev === raw ? "" : prev)),
    );
  }, [client, draft, file.fileKey, readOnly, selection.nodeId, submit]);

  const postReply = useCallback(
    (threadId: string) => {
      if (readOnly) return;
      const current = reply;
      if (!current || current.threadId !== threadId) return;
      const raw = current.text;
      const message = raw.trim();
      if (!message) return;
      submit(
        `reply-${threadId}`,
        () =>
          callFigma(client, "figma.file.comments.post.request", {
            fileKey: file.fileKey,
            message,
            parentId: threadId,
          }),
        // Success: clear the reply only if it is still exactly what was sent, and close the
        // composer then; a re-edited draft stays visible for another attempt.
        () => setReply((r) => (r && r.threadId === threadId && r.text === raw ? null : r)),
      );
    },
    [client, file.fileKey, readOnly, reply, submit],
  );

  const react = useCallback(
    (comment: FigmaComment, emoji: string) => {
      if (readOnly) return;
      const existing = comment.reactions.find((reaction) => reaction.emoji === emoji);
      submit(`react-${comment.id}`, () =>
        callFigma(client, "figma.file.comments.react.request", {
          fileKey: file.fileKey,
          commentId: comment.id,
          emoji,
          remove: Boolean(existing?.mine),
        }),
      );
    },
    [client, file.fileKey, readOnly, submit],
  );

  const removing = useRef(false);
  const remove = useCallback(
    async (commentId: string) => {
      if (readOnly) return;
      const deleteKey = `delete-${commentId}`;
      if (removing.current || inFlight.current[deleteKey]) return;
      const target = comments.find((c) => c.id === commentId);
      if (!target) return;
      const isRoot = !target.parentId;
      const thread = isRoot ? (allThreads.find((t) => t.root.id === commentId) ?? null) : null;
      removing.current = true;
      // Capture the generation BEFORE the dialog: the user may sit on the confirm while the
      // host/file/version changes underneath us (keyed remount bumps the old instance) or the
      // panel closes (unmount bump). A confirm that lands late must send zero old RPC and stamp
      // no stale failure state.
      const gen = generation.current;
      const stale = () => generation.current !== gen;
      let confirmed = false;
      try {
        // Destructive and unrecoverable in Figma: a root delete takes its replies with it, and
        // the confirm says so. Cancel sends zero RPC.
        confirmed = await confirmDialog({
          ...deleteConfirmCopy(thread),
          confirmLabel: "Delete",
          cancelLabel: "Cancel",
          destructive: true,
        });
      } catch (cause) {
        if (!stale()) {
          setFailures((f) => ({
            ...f,
            [deleteKey]: {
              message: errorMessage(cause),
              retry: () => void remove(commentId),
              dismiss: () => clearFailure(deleteKey),
            },
          }));
        }
        removing.current = false;
        return;
      }
      removing.current = false;
      if (stale() || !confirmed) return;
      submit(
        deleteKey,
        () =>
          callFigma(client, "figma.file.comments.delete.request", {
            fileKey: file.fileKey,
            commentId,
          }),
        () => {
          // Closing a reply composer whose thread just died is bookkeeping, not a decision.
          if (isRoot) setReply((r) => (r && r.threadId === commentId ? null : r));
        },
      );
    },
    [clearFailure, client, comments, file.fileKey, readOnly, submit, allThreads],
  );

  const toggleReply = useCallback((threadId: string) => {
    // Opening a different thread starts an empty draft; re-opening the same one restores what
    // the user had (a failed send keeps the composer open with its text).
    setReply((current) => (current?.threadId === threadId ? null : { threadId, text: "" }));
  }, []);

  const retry = useCallback(() => {
    // Explicit re-read of the actual comments query; no live-push claim.
    void commentsRequest.refetch();
  }, [commentsRequest]);

  const showAll = useCallback(() => setOnThisNode(false), []);
  const showOnNode = useCallback(() => setOnThisNode(true), []);
  const toggleMine = useCallback(() => setMineOnly((v) => !v), []);
  const toggleResolved = useCallback(() => setShowResolved((v) => !v), []);
  const sortLatest = useCallback(() => setOrder("latest"), []);
  const sortOldest = useCallback(() => setOrder("oldest"), []);
  const setReplyText = useCallback((text: string) => setReply((r) => (r ? { ...r, text } : r)), []);

  let composerPlaceholder = "Add a comment…";
  if (readOnly) composerPlaceholder = "Viewing a version — comments are read only";
  else if (selection.nodeId) composerPlaceholder = "Comment on the selected node…";

  if (commentsRequest.error && commentsRequest.data === undefined) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>{errorMessage(commentsRequest.error)}</Text>
        <Button variant="outline" size="sm" onPress={retry} testID="figma-comment-retry">
          Retry
        </Button>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>Comments</Text>
        <Button variant="outline" size="xs" onPress={retry} testID="figma-comment-refresh">
          Refresh
        </Button>
      </View>
      <View style={styles.searchRow}>
        <TextInput
          style={styles.input}
          value={search}
          onChangeText={setSearch}
          placeholder="Search messages or authors"
          placeholderTextColor={styles.placeholderColor.color}
          testID="figma-comment-search"
        />
      </View>
      {/* bounded wrapping groups: a narrow Inspect rail (~280px) or a 390px phone never puts
          seven controls on one non-wrapping line with the title */}
      <View style={styles.filterRow}>
        <FilterChip
          label="All"
          active={!onThisNode}
          onPress={showAll}
          testID="figma-comment-filter-all"
        />
        <FilterChip
          label="On this node"
          active={onThisNode}
          disabled={!selection.nodeId}
          onPress={showOnNode}
          testID="figma-comment-filter-node"
        />
        <FilterChip
          label="My threads"
          active={mineOnly}
          onPress={toggleMine}
          testID="figma-comment-filter-mine"
        />
        <FilterChip
          label="Resolved"
          active={showResolved}
          onPress={toggleResolved}
          testID="figma-comment-filter-resolved"
        />
      </View>
      <View style={styles.filterRow}>
        <Text style={styles.filterLabel}>Sort</Text>
        <FilterChip
          label="Latest"
          active={order === "latest"}
          onPress={sortLatest}
          testID="figma-comment-sort-latest"
        />
        <FilterChip
          label="Oldest"
          active={order === "oldest"}
          onPress={sortOldest}
          testID="figma-comment-sort-oldest"
        />
      </View>

      {/* A failed Refresh keeps the displayed list and offers an explicit Retry. */}
      {commentsRequest.error ? (
        <View style={styles.noticeRow} testID="figma-comment-refresh-error">
          <Text style={styles.noticeText} numberOfLines={2}>
            Couldn&apos;t refresh comments: {errorMessage(commentsRequest.error)}
          </Text>
          <Button variant="ghost" size="xs" onPress={retry} testID="figma-comment-refresh-retry">
            Retry
          </Button>
        </View>
      ) : null}

      <CommentsBody
        pending={commentsRequest.isPending}
        threads={visibleThreads}
        filtered={filtersActive}
        readOnly={readOnly}
        now_ms={now_ms}
        reply={reply}
        busy={busy}
        failures={failures}
        onReplyText={setReplyText}
        onToggleReply={toggleReply}
        onSubmitReply={postReply}
        onFocusNode={onFocusNode}
        onFocusPoint={onFocusPoint}
        onReact={react}
        onDelete={remove}
      />

      <View style={styles.composer}>
        <View style={styles.composeRow}>
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder={composerPlaceholder}
            placeholderTextColor={styles.placeholderColor.color}
            submitBehavior="newline"
            onSubmitEditing={post}
            editable={!readOnly}
            testID="figma-comment-input"
          />
          <Button
            size="sm"
            onPress={post}
            disabled={readOnly || Boolean(busy.post) || draft.trim().length === 0}
            loading={Boolean(busy.post)}
            testID="figma-comment-post"
          >
            Post
          </Button>
        </View>
        {failures.post ? (
          <ActionFailureView testID="figma-comment-post-failure" failure={failures.post} />
        ) : null}
      </View>
    </View>
  );
}

function FilterChip({
  label,
  active,
  disabled,
  onPress,
  testID,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      style={[styles.filterChip, active && styles.filterChipActive]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      testID={testID}
    >
      <Text style={[styles.filterLabel, active && styles.filterLabelActive]}>{label}</Text>
    </Pressable>
  );
}

function ActionFailureView({ testID, failure }: { testID: string; failure: ActionFailure }) {
  return (
    <View style={styles.noticeRow} testID={testID}>
      <Text style={styles.noticeText} numberOfLines={2}>
        {failure.message}
      </Text>
      <Button variant="ghost" size="xs" onPress={failure.retry} testID={`${testID}-retry`}>
        Retry
      </Button>
      <Button variant="ghost" size="xs" onPress={failure.dismiss} testID={`${testID}-dismiss`}>
        Dismiss
      </Button>
    </View>
  );
}

interface CommentsBodyProps {
  pending: boolean;
  threads: readonly CommentThread[];
  filtered: boolean;
  readOnly: boolean;
  now_ms: number;
  reply: { threadId: string; text: string } | null;
  busy: BusyMap;
  failures: FailureMap;
  onReplyText: (value: string) => void;
  onToggleReply: (threadId: string) => void;
  onSubmitReply: (threadId: string) => void;
  onFocusNode: (nodeId: string) => void;
  onFocusPoint?: (point: { x: number; y: number }) => void;
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
            {props.filtered ? "No threads match the current filters." : "No comments yet."}
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
          reply={props.reply}
          readOnly={props.readOnly}
          busy={props.busy}
          failures={props.failures}
          onReplyText={props.onReplyText}
          onToggleReply={props.onToggleReply}
          onSubmitReply={props.onSubmitReply}
          onFocusNode={props.onFocusNode}
          onFocusPoint={props.onFocusPoint}
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
  reply: { threadId: string; text: string } | null;
  readOnly: boolean;
  busy: BusyMap;
  failures: FailureMap;
  onReplyText: (value: string) => void;
  onToggleReply: (threadId: string) => void;
  onSubmitReply: (threadId: string) => void;
  onFocusNode: (nodeId: string) => void;
  onFocusPoint?: (point: { x: number; y: number }) => void;
  onReact: (comment: FigmaComment, emoji: string) => void;
  onDelete: (commentId: string) => void;
}

function ThreadCard({
  thread,
  now_ms,
  reply,
  readOnly,
  busy,
  failures,
  onReplyText,
  onToggleReply,
  onSubmitReply,
  onFocusNode,
  onFocusPoint,
  onReact,
  onDelete,
}: ThreadCardProps) {
  const rootId = thread.root.id;
  const openReply = useCallback(() => onToggleReply(rootId), [onToggleReply, rootId]);
  const sendReply = useCallback(() => onSubmitReply(rootId), [onSubmitReply, rootId]);
  const replying = reply?.threadId === rootId;
  return (
    <View style={styles.threadCard}>
      <CommentRow
        comment={thread.root}
        now_ms={now_ms}
        readOnly={readOnly}
        busy={busy}
        failures={failures}
        onFocusNode={onFocusNode}
        onFocusPoint={onFocusPoint}
        onReact={onReact}
        onDelete={onDelete}
      />
      {thread.resolved ? <Text style={styles.resolvedChip}>Resolved</Text> : null}
      {thread.replies.length > 0 ? (
        <View style={styles.replyBlock}>
          {thread.replies.map((replyComment) => (
            <CommentRow
              key={replyComment.id}
              comment={replyComment}
              now_ms={now_ms}
              readOnly={readOnly}
              busy={busy}
              failures={failures}
              onFocusNode={onFocusNode}
              onFocusPoint={onFocusPoint}
              onReact={onReact}
              onDelete={onDelete}
            />
          ))}
        </View>
      ) : null}
      {!readOnly ? (
        <View style={styles.actionRow}>
          <Pressable
            onPress={openReply}
            hitSlop={6}
            accessibilityRole="button"
            testID={`figma-comment-reply-open-${rootId}`}
          >
            <Text style={styles.linkButton}>Reply</Text>
          </Pressable>
        </View>
      ) : null}
      {replying ? (
        <View style={styles.composer}>
          <View style={styles.composeRow}>
            <TextInput
              style={styles.input}
              value={reply?.text ?? ""}
              onChangeText={onReplyText}
              placeholder="Reply…"
              placeholderTextColor={styles.placeholderColor.color}
              submitBehavior="newline"
              onSubmitEditing={sendReply}
              testID={`figma-comment-reply-${rootId}`}
            />
            <Button
              size="xs"
              onPress={sendReply}
              disabled={Boolean(busy[`reply-${rootId}`]) || (reply?.text.trim().length ?? 0) === 0}
              loading={Boolean(busy[`reply-${rootId}`])}
              testID={`figma-comment-reply-send-${rootId}`}
            >
              Send
            </Button>
          </View>
          {/* the failure is a full-width line under the compose row, never a squeeze between
              the input and Send */}
          {failures[`reply-${rootId}`] ? (
            <ActionFailureView
              testID={`figma-comment-reply-failure-${rootId}`}
              failure={failures[`reply-${rootId}`]!}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const EMPTY_BUSY: BusyMap = {};
const EMPTY_FAILURES: FailureMap = {};

export function CommentRow({
  comment,
  now_ms,
  readOnly = false,
  busy = EMPTY_BUSY,
  failures = EMPTY_FAILURES,
  onFocusNode,
  onFocusPoint,
  onReact,
  onDelete,
}: {
  comment: FigmaComment;
  now_ms: number;
  readOnly?: boolean;
  busy?: BusyMap;
  failures?: FailureMap;
  onFocusNode: (nodeId: string) => void;
  onFocusPoint?: (point: { x: number; y: number }) => void;
  onReact: (comment: FigmaComment, emoji: string) => void;
  onDelete: (commentId: string) => void;
}) {
  const handle = comment.user.handle;
  const focus = useCallback(() => {
    if (comment.nodeId) {
      onFocusNode(comment.nodeId);
      return;
    }
    if (comment.offset) onFocusPoint?.(comment.offset);
  }, [comment, onFocusNode, onFocusPoint]);
  const drop = useCallback(() => onDelete(comment.id), [comment, onDelete]);
  // The message keeps its own full-width line: sharing a row with the avatar and the reaction
  // chips used to squeeze it to a few characters per line (F5 bug 4).
  const focusable = comment.nodeId !== null || (comment.offset !== null && !!onFocusPoint);
  return (
    <View style={styles.commentBlock}>
      <View style={styles.headerRow}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials(handle)}</Text>
        </View>
        <Text style={styles.authorName}>{handle}</Text>
        <Text style={styles.timestamp}>{formatRelativeTime(comment.createdAt_ms, now_ms)}</Text>
        {comment.mine && !readOnly ? (
          <Pressable
            style={styles.deleteButton}
            onPress={drop}
            disabled={Boolean(busy[`delete-${comment.id}`])}
            hitSlop={6}
            accessibilityRole="button"
            testID={`figma-comment-delete-${comment.id}`}
          >
            <Text style={styles.linkButton}>Delete</Text>
          </Pressable>
        ) : null}
      </View>
      <Pressable
        style={styles.messageRow}
        onPress={focus}
        disabled={!focusable}
        accessibilityRole={focusable ? "button" : undefined}
        testID={`figma-comment-message-${comment.id}`}
      >
        <Text style={styles.message}>{comment.message}</Text>
      </Pressable>
      <ReactionRow comment={comment} readOnly={readOnly} busy={busy} onReact={onReact} />
      {failures[`react-${comment.id}`] ? (
        <ActionFailureView
          testID={`figma-comment-reaction-failure-${comment.id}`}
          failure={failures[`react-${comment.id}`]!}
        />
      ) : null}
      {failures[`delete-${comment.id}`] ? (
        <ActionFailureView
          testID={`figma-comment-delete-failure-${comment.id}`}
          failure={failures[`delete-${comment.id}`]!}
        />
      ) : null}
    </View>
  );
}

function ReactionRow({
  comment,
  readOnly,
  busy,
  onReact,
}: {
  comment: FigmaComment;
  readOnly: boolean;
  busy: BusyMap;
  onReact: (comment: FigmaComment, emoji: string) => void;
}) {
  // Only real reactions render: zero-count chips are decoration, not information.
  const visible = comment.reactions.filter((reaction) => reaction.count > 0);
  if (visible.length === 0) return null;
  return (
    <View style={styles.reactionRow}>
      {visible.map((reaction) => (
        <ReactionChip
          key={reaction.emoji}
          comment={comment}
          emoji={reaction.emoji}
          count={reaction.count}
          mine={reaction.mine}
          readOnly={readOnly}
          disabled={Boolean(busy[`react-${comment.id}`])}
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
  readOnly,
  disabled,
  onReact,
}: {
  comment: FigmaComment;
  emoji: string;
  count: number;
  mine: boolean;
  readOnly: boolean;
  disabled: boolean;
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
      disabled={readOnly || disabled}
      accessibilityRole="button"
      testID={`figma-reaction-${emoji}`}
    >
      <Text style={styles.reactionText}>
        {renderEmoji(emoji)} {count}
      </Text>
    </Pressable>
  );
}

/**
 * The delete confirm wording: a root takes its replies with it and says how many, a reply is
 * one comment. Cross-platform presentation is `@/utils/confirm-dialog`'s problem, not ours.
 */
function deleteConfirmCopy(thread: CommentThread | null): { title: string; message: string } {
  if (!thread) {
    return { title: "Delete comment?", message: "This deletes the reply. Figma can't undo this." };
  }
  const undo = "Figma can't undo this.";
  if (thread.replies.length === 0) {
    return { title: "Delete thread?", message: `This deletes the comment. ${undo}` };
  }
  const noun = thread.replies.length === 1 ? "reply" : "replies";
  return {
    title: "Delete thread?",
    message: `This deletes the comment and its ${thread.replies.length} ${noun}. ${undo}`,
  };
}

function initials(handle: string): string {
  const parts = handle.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((part) => part[0]!.toUpperCase());
  return letters.join("") || "?";
}

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
  filterRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[1],
  },
  searchRow: { paddingHorizontal: theme.spacing[4], paddingBottom: theme.spacing[2] },
  noticeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  noticeText: { flex: 1, fontSize: theme.fontSize.xs, color: theme.colors.statusDanger },
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
  commentBlock: { gap: theme.spacing[1] },
  headerRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  messageRow: { width: "100%" },
  deleteButton: { marginLeft: "auto" },
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
    flexDirection: "column",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  composeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
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
}));
