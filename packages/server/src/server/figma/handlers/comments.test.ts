import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FigmaCommentsListResponseSchema,
  FigmaCommentsPostResponseSchema,
} from "@jagentdesk/protocol/figma/rpc-schemas";
import { FigmaServiceError, type FigmaContext, type FigmaLinkBridge } from "../context.js";
import { commentsHandlers } from "./comments.js";
import {
  fakeConnection,
  fakeFile,
  fakeLink,
  fakeRest,
  fakeStore,
  makeFigmaContext,
} from "../test-support/fake-figma.js";

// Unit tests for the comments group (32.5.4) against realistic Figma REST samples: the mapping
// decides `mine` from the connection account, reads the pin from client_meta, and groups
// per-user reactions into { emoji, count, mine }. No network — the REST client is a fake.

const here = path.dirname(fileURLToPath(import.meta.url));

function loadFixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(
    readFileSync(path.join(here, "..", "__fixtures__", name), "utf8"),
  ) as unknown as T;
}

const FILE_KEY = "Kx7QmP2vTnYhW3cLdRf5Ba";
const ACCOUNT_USER_ID = "450:900";
const session = { sessionKey: "s1", canRunLoopback: false };

// A link bridge no comment handler may touch.
const linkUnused: FigmaLinkBridge = fakeLink({}).link;

function contextFor(
  options: { getJson?: () => unknown; sendJson?: () => unknown; link?: FigmaLinkBridge } = {},
): { ctx: FigmaContext; restCalls: ReturnType<typeof fakeRest>["calls"] } {
  const rest = fakeRest({ getJson: options.getJson, sendJson: options.sendJson });
  const ctx = makeFigmaContext({
    store: fakeStore({
      files: [fakeFile({ fileKey: FILE_KEY })],
      connections: [
        fakeConnection({
          account: { figmaUserId: ACCOUNT_USER_ID, handle: "me", email: null },
        }),
      ],
    }),
    rest: rest.rest,
    link: options.link ?? linkUnused,
  });
  return { ctx, restCalls: rest.calls };
}

describe("comments.list", () => {
  it("maps the REST comments to wire DTOs with mine, pins and grouped reactions", async () => {
    const { ctx, restCalls } = contextFor({ getJson: () => loadFixture("comments.rest.json") });
    const result = await commentsHandlers["figma.file.comments.list.request"](
      { type: "figma.file.comments.list.request", requestId: "r1", fileKey: FILE_KEY },
      ctx,
      session,
    );
    const [root, reply, canvasPin] = result.comments;

    expect(root).toEqual({
      id: "101",
      parentId: null,
      message: 'Update the CTA copy to "Start free trial".',
      user: { handle: "ravi", figmaUserId: "450:111" },
      createdAt_ms: Date.parse("2026-04-02T09:15:00Z"),
      resolvedAt_ms: null,
      nodeId: "23:4",
      offset: { x: 312.5, y: 88 },
      reactions: [
        { emoji: ":+1:", count: 2, mine: false },
        { emoji: ":tada:", count: 1, mine: false },
      ],
      mine: false,
    });

    expect(reply).toMatchObject({ id: "102", parentId: "101", reactions: [], mine: false });
    expect(reply?.resolvedAt_ms).toBeNull();

    // Canvas-pinned comment: the offset comes from the bare Vector, there is no node; written
    // and reacted on by the connection account itself, and resolved.
    expect(canvasPin).toMatchObject({
      id: "103",
      parentId: null,
      nodeId: null,
      offset: { x: 1440, y: 96 },
      mine: true,
      resolvedAt_ms: Date.parse("2026-04-04T12:30:00Z"),
      reactions: [{ emoji: ":+1:", count: 2, mine: true }],
    });

    expect(restCalls).toEqual([
      {
        method: "GET",
        connectionId: "fgc_test",
        path: `/v1/files/${FILE_KEY}/comments`,
        tier: "2",
      },
    ]);
    expect(() =>
      FigmaCommentsListResponseSchema.parse({
        type: "figma.file.comments.list.response",
        payload: { requestId: "r1", error: null, comments: result.comments },
      }),
    ).not.toThrow();
  });

  it("fails when the file is not in the store", async () => {
    const rest = fakeRest({});
    const ctx = makeFigmaContext({
      store: fakeStore({ files: [], connections: [] }),
      rest: rest.rest,
      link: linkUnused,
    });
    const error = await commentsHandlers["figma.file.comments.list.request"](
      { type: "figma.file.comments.list.request", requestId: "r1", fileKey: "missing" },
      ctx,
      session,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FigmaServiceError);
    expect((error as FigmaServiceError).code).toBe("not_found");
    expect(rest.calls).toEqual([]);
  });

  it("fails when the file's connection is gone", async () => {
    const ctx = makeFigmaContext({
      store: fakeStore({ files: [fakeFile({ fileKey: FILE_KEY })], connections: [] }),
      rest: fakeRest({}).rest,
      link: linkUnused,
    });
    const error = await commentsHandlers["figma.file.comments.list.request"](
      { type: "figma.file.comments.list.request", requestId: "r1", fileKey: FILE_KEY },
      ctx,
      session,
    ).catch((caught: unknown) => caught);
    expect((error as FigmaServiceError).code).toBe("not_found");
  });

  it("throws a figma_error when a timestamp is unreadable", async () => {
    const { ctx } = contextFor({
      getJson: () => ({
        comments: [
          {
            id: "1",
            message: "hi",
            user: { id: ACCOUNT_USER_ID, handle: "me" },
            created_at: "yesterday",
            reactions: [],
          },
        ],
      }),
    });
    const error = await commentsHandlers["figma.file.comments.list.request"](
      { type: "figma.file.comments.list.request", requestId: "r1", fileKey: FILE_KEY },
      ctx,
      session,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FigmaServiceError);
    expect((error as FigmaServiceError).code).toBe("figma_error");
  });
});

describe("comments.post", () => {
  it("posts a node-anchored comment with client_meta and maps the returned comment", async () => {
    const { ctx, restCalls } = contextFor({ sendJson: () => loadFixture("comment.posted.json") });
    const result = await commentsHandlers["figma.file.comments.post.request"](
      {
        type: "figma.file.comments.post.request",
        requestId: "r1",
        fileKey: FILE_KEY,
        message: "Darkened the primary CTA.",
        nodeId: "23:4",
        offset: { x: 312.5, y: 88 },
        parentId: "101",
      },
      ctx,
      session,
    );

    expect(restCalls).toEqual([
      {
        method: "POST",
        connectionId: "fgc_test",
        path: `/v1/files/${FILE_KEY}/comments`,
        body: {
          message: "Darkened the primary CTA.",
          comment_id: "101",
          client_meta: { node_id: "23:4", node_offset: { x: 312.5, y: 88 } },
        },
        tier: "2",
      },
    ]);
    expect(result.comment).toMatchObject({
      id: "104",
      parentId: null,
      nodeId: "23:4",
      offset: { x: 312.5, y: 88 },
      user: { handle: "me", figmaUserId: ACCOUNT_USER_ID },
      mine: true,
      reactions: [],
    });
    expect(() =>
      FigmaCommentsPostResponseSchema.parse({
        type: "figma.file.comments.post.response",
        payload: { requestId: "r1", error: null, comment: result.comment },
      }),
    ).not.toThrow();
  });

  it("anchors to the node top-left without an offset and omits client_meta for plain comments", async () => {
    const { ctx, restCalls } = contextFor({ sendJson: () => loadFixture("comment.posted.json") });
    const post = (params: { message: string; nodeId?: string }) =>
      commentsHandlers["figma.file.comments.post.request"](
        { type: "figma.file.comments.post.request", requestId: "r1", fileKey: FILE_KEY, ...params },
        ctx,
        session,
      );

    await post({ message: "Anchored without an offset.", nodeId: "23:4" });
    await post({ message: "Plain comment." });

    expect(restCalls[0]?.body).toEqual({
      message: "Anchored without an offset.",
      client_meta: { node_id: "23:4", node_offset: { x: 0, y: 0 } },
    });
    expect(restCalls[1]?.body).toEqual({ message: "Plain comment." });
  });
});

describe("comments.delete + comments.react", () => {
  it("deletes a comment by id on tier 2", async () => {
    const { ctx, restCalls } = contextFor({ sendJson: () => ({ status: 200, error: false }) });
    const result = await commentsHandlers["figma.file.comments.delete.request"](
      {
        type: "figma.file.comments.delete.request",
        requestId: "r1",
        fileKey: FILE_KEY,
        commentId: "104",
      },
      ctx,
      session,
    );
    expect(result).toEqual({});
    expect(restCalls).toEqual([
      {
        method: "DELETE",
        connectionId: "fgc_test",
        path: `/v1/files/${FILE_KEY}/comments/104`,
        body: undefined,
        tier: "2",
      },
    ]);
  });

  it("POSTs the shortcode to react and DELETEs with the emoji query to un-react", async () => {
    const { ctx, restCalls } = contextFor({ sendJson: () => ({ status: 200, error: false }) });
    const react = (remove: boolean) =>
      commentsHandlers["figma.file.comments.react.request"](
        {
          type: "figma.file.comments.react.request",
          requestId: "r1",
          fileKey: FILE_KEY,
          commentId: "104",
          emoji: ":+1:",
          remove,
        },
        ctx,
        session,
      );

    await expect(react(false)).resolves.toEqual({});
    await expect(react(true)).resolves.toEqual({});

    expect(restCalls[0]).toEqual({
      method: "POST",
      connectionId: "fgc_test",
      path: `/v1/files/${FILE_KEY}/comments/104/reactions`,
      body: { emoji: ":+1:" },
      tier: "2",
    });
    expect(restCalls[1]).toEqual({
      method: "DELETE",
      connectionId: "fgc_test",
      path: `/v1/files/${FILE_KEY}/comments/104/reactions?emoji=${encodeURIComponent(":+1:")}`,
      body: undefined,
      tier: "2",
    });
  });
});
