import type {
  FigmaComment,
  FigmaConnection,
  FigmaFile,
} from "@jagentdesk/protocol/figma/rpc-schemas";
import { FigmaServiceError, type FigmaContext } from "../context.js";
import { buildPrototype, isoMs, num, obj, objs, str, type Json } from "../prototype.js";
import type { FigmaHandlerMap } from "./types.js";

// Comments (32.5.4) and prototype data (32.5.3). Owner: W5.
//
// Comments ride the REST Tier-2 endpoints (figma-integration.md §3.2): the file's connection comes
// from the store, `mine` is decided against the connection account's figmaUserId, and per-comment
// reactions are grouped into { emoji, count, mine }. The delete and react endpoints map Figma's
// errors (403 non-author, 400 bad shortcode) through the REST client.

export type CommentsRequestType =
  | "figma.file.comments.list.request"
  | "figma.file.comments.post.request"
  | "figma.file.comments.delete.request"
  | "figma.file.comments.react.request"
  | "figma.file.prototype.request";

export const commentsHandlers: FigmaHandlerMap<CommentsRequestType> = {
  "figma.file.comments.list.request": async (request, ctx) => {
    const { connection } = await requireConnection(request.fileKey, ctx);
    const response = await ctx.rest.getJson({
      connectionId: connection.id,
      path: `/v1/files/${request.fileKey}/comments`,
      tier: "2",
    });
    const comments = objs(obj(response)?.comments).map((raw) =>
      mapComment(raw, connection.account.figmaUserId),
    );
    return { comments };
  },

  "figma.file.comments.post.request": async (request, ctx) => {
    const { connection } = await requireConnection(request.fileKey, ctx);
    const body: Json = { message: request.message };
    if (request.parentId) body.comment_id = request.parentId;
    const clientMeta = buildClientMeta(request.nodeId, request.offset);
    if (clientMeta) body.client_meta = clientMeta;
    const posted = await ctx.rest.sendJson<Json>({
      connectionId: connection.id,
      method: "POST",
      path: `/v1/files/${request.fileKey}/comments`,
      body,
      tier: "2",
    });
    return { comment: mapComment(posted, connection.account.figmaUserId) };
  },

  "figma.file.comments.delete.request": async (request, ctx) => {
    const { connection } = await requireConnection(request.fileKey, ctx);
    await ctx.rest.sendJson({
      connectionId: connection.id,
      method: "DELETE",
      path: `/v1/files/${request.fileKey}/comments/${encodeURIComponent(request.commentId)}`,
      tier: "2",
    });
    return {};
  },

  "figma.file.comments.react.request": async (request, ctx) => {
    const { connection } = await requireConnection(request.fileKey, ctx);
    const path = `/v1/files/${request.fileKey}/comments/${encodeURIComponent(
      request.commentId,
    )}/reactions`;
    if (request.remove) {
      await ctx.rest.sendJson({
        connectionId: connection.id,
        method: "DELETE",
        path: `${path}?emoji=${encodeURIComponent(request.emoji)}`,
        tier: "2",
      });
    } else {
      await ctx.rest.sendJson({
        connectionId: connection.id,
        method: "POST",
        path,
        body: { emoji: request.emoji },
        tier: "2",
      });
    }
    return {};
  },

  "figma.file.prototype.request": async (request, ctx) => {
    const { connection } = await requireConnection(request.fileKey, ctx);
    const prototype = await buildPrototype({
      fileKey: request.fileKey,
      connectionId: connection.id,
      pageId: request.pageId,
      rest: ctx.rest,
      link: ctx.link,
    });
    return { prototype };
  },
};

/** The file's own connection (32.3 store), or a `not_found` the session puts on the wire. */
async function requireConnection(
  fileKey: string,
  ctx: FigmaContext,
): Promise<{ file: FigmaFile; connection: FigmaConnection }> {
  const file = await ctx.store.getFile(fileKey);
  if (!file) {
    throw new FigmaServiceError("not_found", `Add the file ${fileKey} to JAgentDesk first.`);
  }
  const connection = await ctx.store.getConnection(file.connectionId);
  if (!connection) {
    throw new FigmaServiceError(
      "not_found",
      `The connection for file ${fileKey} no longer exists.`,
    );
  }
  return { file, connection };
}

function mapComment(raw: Json, figmaUserId: string): FigmaComment {
  const user = obj(raw.user);
  const authorId = str(user?.id) ?? "";
  const meta = obj(raw.client_meta);
  return {
    id: str(raw.id) ?? "",
    parentId: str(raw.parent_id),
    message: str(raw.message) ?? "",
    user: { handle: str(user?.handle) ?? "", figmaUserId: authorId },
    createdAt_ms: isoMs(raw.created_at, "created_at"),
    resolvedAt_ms: raw.resolved_at == null ? null : isoMs(raw.resolved_at, "resolved_at"),
    nodeId: str(meta?.node_id) ?? str(raw.node_id),
    offset: readPinOffset(meta),
    reactions: groupReactions(raw.reactions, figmaUserId),
    mine: authorId !== "" && authorId === figmaUserId,
  };
}

/** The pin position relative to the node (`node_offset`) or the canvas (`x`/`y`). */
function readPinOffset(meta: Json | null): { x: number; y: number } | null {
  if (!meta) return null;
  const nodeOffset = obj(meta.node_offset);
  const point = nodeOffset ?? meta;
  const x = num(point.x);
  const y = num(point.y);
  return x === null || y === null ? null : { x, y };
}

function groupReactions(
  raw: unknown,
  figmaUserId: string,
): { emoji: string; count: number; mine: boolean }[] {
  const groups = new Map<string, { emoji: string; count: number; mine: boolean }>();
  for (const reaction of objs(raw)) {
    const emoji = str(reaction.emoji);
    if (!emoji) continue;
    const mine = str(obj(reaction.user)?.id) === figmaUserId;
    const group = groups.get(emoji);
    if (group) {
      group.count += 1;
      group.mine = group.mine || mine;
    } else {
      groups.set(emoji, { emoji, count: 1, mine });
    }
  }
  return [...groups.values()];
}

/**
 * Figma's `client_meta` anchor (figma-integration.md §3.2): a node-anchored comment is a
 * `FrameOffset` ({ node_id, node_offset }); a canvas comment is a `Vector` ({ x, y }).
 */
function buildClientMeta(
  nodeId: string | undefined,
  offset: { x: number; y: number } | undefined,
): Json | null {
  if (nodeId) {
    return { node_id: nodeId, node_offset: offset ?? { x: 0, y: 0 } };
  }
  if (offset) return { x: offset.x, y: offset.y };
  return null;
}
