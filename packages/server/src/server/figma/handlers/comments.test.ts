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
      // ADR-0041: point pins answer null in new responses — the field is never omitted.
      region: null,
      reactions: [
        { emoji: ":+1:", count: 2, mine: false },
        { emoji: ":tada:", count: 1, mine: false },
      ],
      mine: false,
    });

    expect(reply).toMatchObject({ id: "102", parentId: "101", reactions: [], mine: false });
    expect(reply?.resolvedAt_ms).toBeNull();

    // Canvas region pin (ADR-0041): offset from the `Region` x/y, geometry preserved exactly —
    // written and reacted on by the connection account itself, and resolved.
    expect(canvasPin).toMatchObject({
      id: "103",
      parentId: null,
      nodeId: null,
      offset: { x: 1440, y: 96 },
      region: { width: 200, height: 80, pinCorner: "bottom-right" },
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

// ── ADR-0041: comment region geometry ─────────────────────────────────────────

function restComment(id: string, clientMeta: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    client_id: 900 + Number(id),
    parent_id: "",
    message: `Comment ${id}.`,
    user: { id: ACCOUNT_USER_ID, handle: "me", img_url: null },
    created_at: "2026-04-05T07:30:00Z",
    resolved_at: null,
    order_id: null,
    file_key: FILE_KEY,
    client_meta: clientMeta,
    reactions: [],
  };
}

async function listOne(clientMeta: Record<string, unknown> | null) {
  const { ctx } = contextFor({
    getJson: () => ({ comments: [restComment("201", clientMeta ?? {})] }),
  });
  const result = await commentsHandlers["figma.file.comments.list.request"](
    { type: "figma.file.comments.list.request", requestId: "r1", fileKey: FILE_KEY },
    ctx,
    session,
  );
  return result.comments[0];
}

describe("comments.list region mapping (ADR-0041)", () => {
  it("maps Vector and FrameOffset point pins with region null, exactly", async () => {
    const vector = await listOne({ x: 1440, y: 96 });
    expect(vector).toMatchObject({ nodeId: null, offset: { x: 1440, y: 96 }, region: null });
    const frameOffset = await listOne({ node_id: "23:4", node_offset: { x: 312.5, y: 88 } });
    expect(frameOffset).toMatchObject({
      nodeId: "23:4",
      offset: { x: 312.5, y: 88 },
      region: null,
    });
  });

  it("preserves the geometry for all four corners on Region and FrameOffsetRegion", async () => {
    for (const pinCorner of ["top-left", "top-right", "bottom-left", "bottom-right"] as const) {
      const canvas = await listOne({
        x: 100,
        y: 200,
        region_width: 240,
        region_height: 90.5,
        comment_pin_corner: pinCorner,
      });
      expect(canvas).toMatchObject({
        nodeId: null,
        offset: { x: 100, y: 200 },
        region: { width: 240, height: 90.5, pinCorner },
      });
      const node = await listOne({
        node_id: "23:4",
        node_offset: { x: 100, y: 200 },
        region_width: 240,
        region_height: 90.5,
        comment_pin_corner: pinCorner,
      });
      expect(node).toMatchObject({
        nodeId: "23:4",
        offset: { x: 100, y: 200 },
        region: { width: 240, height: 90.5, pinCorner },
      });
    }
  });

  it("defaults an omitted comment_pin_corner to Figma's documented bottom-right", async () => {
    const canvas = await listOne({ x: 1, y: 2, region_width: 3, region_height: 4 });
    expect(canvas?.region).toEqual({ width: 3, height: 4, pinCorner: "bottom-right" });
    const node = await listOne({
      node_id: "9:9",
      node_offset: { x: 1, y: 2 },
      region_width: 3,
      region_height: 4,
    });
    expect(node?.region).toEqual({ width: 3, height: 4, pinCorner: "bottom-right" });
  });

  it("keeps the region response wire-valid", async () => {
    const comment = await listOne({
      x: 1,
      y: 2,
      region_width: 3,
      region_height: 4,
      comment_pin_corner: "top-left",
    });
    expect(() =>
      FigmaCommentsListResponseSchema.parse({
        type: "figma.file.comments.list.response",
        payload: { requestId: "r1", error: null, comments: [comment] },
      }),
    ).not.toThrow();
  });

  it("refuses malformed regions with a clear error instead of guessed geometry", async () => {
    const malformed: Record<string, unknown>[] = [
      { x: 1, y: 2, region_width: 0, region_height: 4 }, // zero dimension
      { x: 1, y: 2, region_width: 3, region_height: -4 }, // negative dimension
      { x: 1, y: 2, region_width: Infinity, region_height: 4 }, // non-finite
      { x: 1, y: 2, region_width: "3", region_height: 4 }, // non-number
      { x: 1, y: 2, region_width: 3 }, // height missing
      { x: 1, y: 2, region_height: 4 }, // width missing
      { x: 1, y: 2, comment_pin_corner: "bottom-left" }, // corner without dimensions
      { x: 1, y: 2, region_width: 3, region_height: 4, comment_pin_corner: "middle" }, // bad corner
      { x: 1, y: 2, region_width: 3, region_height: 4, comment_pin_corner: 2 }, // non-string corner
    ];
    for (const meta of malformed) {
      const error = await listOne(meta).then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error, JSON.stringify(meta)).toBeInstanceOf(FigmaServiceError);
      expect((error as FigmaServiceError).code).toBe("figma_error");
      expect((error as FigmaServiceError).message).toContain("201");
      expect((error as FigmaServiceError).message).toContain("region");
    }
  });

  it("null or absent client_meta reads as a plain comment (region null)", async () => {
    expect((await listOne(null))?.region).toBeNull();
  });
});

describe("comments.post region pin (ADR-0041)", () => {
  const REGION = { width: 200, height: 80, pinCorner: "top-left" } as const;

  function postRequest(params: Record<string, unknown>) {
    return {
      type: "figma.file.comments.post.request",
      requestId: "r1",
      fileKey: FILE_KEY,
      message: "Region pinned here.",
      ...params,
    } as Parameters<(typeof commentsHandlers)["figma.file.comments.post.request"]>[0];
  }

  it("maps a frame region to node-anchored client_meta with the region fields", async () => {
    const { ctx, restCalls } = contextFor({
      sendJson: () => ({
        ...restComment("105", {
          node_id: "23:4",
          node_offset: { x: 312.5, y: 88 },
          region_width: 200,
          region_height: 80,
          comment_pin_corner: "top-left",
        }),
      }),
    });
    const result = await commentsHandlers["figma.file.comments.post.request"](
      postRequest({ nodeId: "23:4", offset: { x: 312.5, y: 88 }, region: REGION }),
      ctx,
      session,
    );
    expect(restCalls[0]?.body).toEqual({
      message: "Region pinned here.",
      client_meta: {
        node_id: "23:4",
        node_offset: { x: 312.5, y: 88 },
        region_width: 200,
        region_height: 80,
        comment_pin_corner: "top-left",
      },
    });
    expect(result.comment).toMatchObject({
      nodeId: "23:4",
      offset: { x: 312.5, y: 88 },
      region: { width: 200, height: 80, pinCorner: "top-left" },
    });
    expect(() =>
      FigmaCommentsPostResponseSchema.parse({
        type: "figma.file.comments.post.response",
        payload: { requestId: "r1", error: null, comment: result.comment },
      }),
    ).not.toThrow();
  });

  it("maps a canvas region to x/y client_meta with the region fields", async () => {
    const { ctx, restCalls } = contextFor({ sendJson: () => restComment("106", {}) });
    await commentsHandlers["figma.file.comments.post.request"](
      postRequest({ offset: { x: 1440, y: 96 }, region: { ...REGION, pinCorner: "bottom-right" } }),
      ctx,
      session,
    );
    expect(restCalls[0]?.body).toEqual({
      message: "Region pinned here.",
      client_meta: {
        x: 1440,
        y: 96,
        region_width: 200,
        region_height: 80,
        comment_pin_corner: "bottom-right",
      },
    });
  });

  it("refuses a region without an explicit finite offset BEFORE any REST call", async () => {
    const { ctx, restCalls } = contextFor({ sendJson: () => restComment("107", {}) });
    const cases: Record<string, unknown>[] = [
      { region: REGION }, // no offset at all
      { nodeId: "23:4", region: REGION }, // node default {0,0} is a made-up location
      { offset: { x: Number.POSITIVE_INFINITY, y: 4 }, region: REGION }, // non-finite
      { offset: { x: 1, y: Number.NaN }, region: REGION }, // NaN
    ];
    for (const params of cases) {
      const error = await commentsHandlers["figma.file.comments.post.request"](
        postRequest(params),
        ctx,
        session,
      ).catch((caught: unknown) => caught);
      expect(error, JSON.stringify(params)).toBeInstanceOf(FigmaServiceError);
      expect((error as FigmaServiceError).message).toContain("offset");
    }
    expect(restCalls).toEqual([]); // nothing reached REST
  });

  it("keeps point posts unchanged: no region, no region fields in client_meta", async () => {
    const { ctx, restCalls } = contextFor({ sendJson: () => restComment("108", {}) });
    await commentsHandlers["figma.file.comments.post.request"](
      postRequest({ nodeId: "23:4", offset: { x: 1, y: 2 } }),
      ctx,
      session,
    );
    expect(restCalls[0]?.body).toEqual({
      message: "Region pinned here.",
      client_meta: { node_id: "23:4", node_offset: { x: 1, y: 2 } },
    });
  });
});
