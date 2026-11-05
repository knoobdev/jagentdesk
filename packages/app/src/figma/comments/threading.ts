import type { FigmaComment } from "@jagentdesk/protocol/figma/rpc-schemas";

// Threads over the flat comment list from `figma.file.comments.list` (spec 32.5.4). A thread is
// a root comment (no parentId) plus its replies; replies whose chain never reaches a listed
// root are dropped; the "On this node" filter is exact on the root's nodeId; a thread counts as
// resolved when any comment in it carries resolvedAt.

export interface CommentThread {
  root: FigmaComment;
  replies: FigmaComment[];
  lastActivity_ms: number;
  resolved: boolean;
}

export function buildThreads(comments: readonly FigmaComment[]): CommentThread[] {
  const byId = new Map<string, FigmaComment>();
  for (const comment of comments) byId.set(comment.id, comment);
  const childrenOf = new Map<string, FigmaComment[]>();
  const roots: FigmaComment[] = [];
  for (const comment of comments) {
    // Figma's REST shape uses "" (not null) for "no parent"; an empty parentId is a root, and the
    // null type union is kept because the server normalizer can emit null too.
    const parentId = comment.parentId?.trim() ?? "";
    if (parentId === "") {
      roots.push(comment);
      continue;
    }
    if (!byId.has(parentId)) continue;
    const siblings = childrenOf.get(parentId);
    if (siblings) siblings.push(comment);
    else childrenOf.set(parentId, [comment]);
  }
  const threads: CommentThread[] = [];
  for (const root of roots) {
    const replies: FigmaComment[] = [];
    const queue = [...(childrenOf.get(root.id) ?? [])];
    const seen = new Set<string>([root.id]);
    while (queue.length > 0) {
      const comment = queue.shift();
      if (!comment || seen.has(comment.id)) continue;
      seen.add(comment.id);
      replies.push(comment);
      queue.push(...(childrenOf.get(comment.id) ?? []));
    }
    replies.sort((a, b) => a.createdAt_ms - b.createdAt_ms);
    const all = [root, ...replies];
    threads.push({
      root,
      replies,
      lastActivity_ms: Math.max(...all.map((comment) => comment.createdAt_ms)),
      resolved: all.some((comment) => comment.resolvedAt_ms !== null),
    });
  }
  return threads.sort((a, b) => b.lastActivity_ms - a.lastActivity_ms);
}

/** Threads anchored to one node ("On this node"); a null filter keeps everything. */
export function filterThreadsByNode(
  threads: readonly CommentThread[],
  nodeId: string | null,
): CommentThread[] {
  if (!nodeId) return [...threads];
  return threads.filter((thread) => thread.root.nodeId === nodeId);
}

export function threadsForNode(
  comments: readonly FigmaComment[],
  nodeId: string | null,
): CommentThread[] {
  return filterThreadsByNode(buildThreads(comments), nodeId);
}

/** Local preview of pressing a reaction chip: adds, removes, or flips `mine` on the emoji. */
export function toggleReaction(comment: FigmaComment, emoji: string): FigmaComment["reactions"] {
  const existing = comment.reactions.find((reaction) => reaction.emoji === emoji);
  if (!existing) return [...comment.reactions, { emoji, count: 1, mine: true }];
  if (existing.mine) {
    if (existing.count <= 1) return comment.reactions.filter((r) => r !== existing);
    return comment.reactions.map((r) =>
      r === existing ? { ...r, count: r.count - 1, mine: false } : r,
    );
  }
  return comment.reactions.map((r) =>
    r === existing ? { ...r, count: r.count + 1, mine: true } : r,
  );
}
