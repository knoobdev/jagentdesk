import { describe, expect, it } from "vitest";
import {
  applyThreadFilters,
  buildThreads,
  filterThreadsByNode,
  threadsForNode,
  toggleReaction,
  type ThreadFilter,
} from "./threading";
import { comment } from "./test-support/comments";

describe("buildThreads", () => {
  it("groups replies under their root and orders by activity", () => {
    const threads = buildThreads([
      comment("r1", { message: "older thread", createdAt_ms: 100 }),
      comment("r2", { message: "newest thread", createdAt_ms: 300 }),
      comment("a", { parentId: "r2", message: "reply", createdAt_ms: 400 }),
      comment("b", { parentId: "r2", message: "earlier reply", createdAt_ms: 350 }),
    ]);
    expect(threads.map((t) => t.root.id)).toEqual(["r2", "r1"]);
    expect(threads[0].replies.map((r) => r.id)).toEqual(["b", "a"]);
    expect(threads[0].replies.map((r) => r.createdAt_ms)).toEqual([350, 400]);
    expect(threads[0].lastActivity_ms).toBe(400);
  });

  it("flattens nested reply chains into one thread", () => {
    const threads = buildThreads([
      comment("root"),
      comment("child", { parentId: "root", createdAt_ms: 200 }),
      comment("grandchild", { parentId: "child", createdAt_ms: 100 }),
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0].replies.map((r) => r.id)).toEqual(["grandchild", "child"]);
  });

  it("drops replies whose chain never reaches a listed root", () => {
    const threads = buildThreads([
      comment("root"),
      comment("orphan", { parentId: "gone" }),
      comment("adopted", { parentId: "orphan" }),
    ]);
    expect(threads[0].replies).toEqual([]);
  });

  it("marks a thread resolved when any comment carries resolvedAt", () => {
    const threads = buildThreads([comment("r"), comment("a", { parentId: "r", resolvedAt_ms: 5 })]);
    expect(threads[0].resolved).toBe(true);
  });

  it("survives duplicated ids in the reply graph", () => {
    const threads = buildThreads([
      comment("root"),
      comment("x", { parentId: "root" }),
      comment("x", { parentId: "root", createdAt_ms: 300 }),
    ]);
    expect(threads[0].replies.map((r) => r.id)).toEqual(["x"]);
  });

  it("treats an empty-string parentId like null: the comment stays a root", () => {
    const threads = buildThreads([
      comment("empty", { parentId: "" }),
      comment("spaced", { parentId: "  " }),
      comment("null", { parentId: null }),
      comment("child", { parentId: "empty" }),
    ]);
    expect(threads.map((t) => t.root.id).sort()).toEqual(["empty", "null", "spaced"]);
    const empty = threads.find((t) => t.root.id === "empty");
    expect(empty?.replies.map((r) => r.id)).toEqual(["child"]);
  });
});

describe("filterThreadsByNode", () => {
  const comments = [
    comment("r1", { nodeId: "1:2" }),
    comment("r2", { nodeId: "1:3" }),
    comment("reply", { parentId: "r1", nodeId: null }),
    comment("canvas", { nodeId: null }),
  ];

  it("keeps exact-node threads by the root anchor", () => {
    const threads = threadsForNode(comments, "1:2");
    expect(threads.map((t) => t.root.id)).toEqual(["r1"]);
  });

  it("a null filter keeps everything, canvas pins included", () => {
    expect(filterThreadsByNode(buildThreads(comments), null)).toHaveLength(3);
    expect(threadsForNode(comments, "nope")).toHaveLength(0);
  });
});

describe("toggleReaction", () => {
  it("adds a first reaction", () => {
    expect(toggleReaction(comment("r", { reactions: [] }), ":+1:")).toEqual([
      { emoji: ":+1:", count: 1, mine: true },
    ]);
  });

  it("increments a foreign reaction", () => {
    const base = comment("r", {
      reactions: [{ emoji: ":+1:", count: 4, mine: false }],
    });
    expect(toggleReaction(base, ":+1:")).toEqual([{ emoji: ":+1:", count: 5, mine: true }]);
  });

  it("decrements and drops my own reaction", () => {
    const base = comment("r", {
      reactions: [{ emoji: ":+1:", count: 2, mine: true }],
    });
    expect(toggleReaction(base, ":+1:")).toEqual([{ emoji: ":+1:", count: 1, mine: false }]);
    expect(
      toggleReaction(comment("r", { reactions: [{ emoji: "🎉", count: 1, mine: true }] }), "🎉"),
    ).toEqual([]);
  });

  it("leaves other reactions untouched", () => {
    const base = comment("r", {
      reactions: [
        { emoji: "🎉", count: 3, mine: false },
        { emoji: ":+1:", count: 1, mine: false },
      ],
    });
    expect(toggleReaction(base, ":+1:")).toEqual([
      { emoji: "🎉", count: 3, mine: false },
      { emoji: ":+1:", count: 2, mine: true },
    ]);
  });
});

describe("applyThreadFilters", () => {
  const base: ThreadFilter = {
    query: "",
    mineOnly: false,
    showResolved: false,
    order: "latest",
    nodeId: null,
  };
  const threads = () =>
    buildThreads([
      comment("open", { message: "open thread", createdAt_ms: 100 }),
      comment("done", { message: "done thread", createdAt_ms: 200, resolvedAt_ms: 250 }),
      comment("mine", { message: "my thread", createdAt_ms: 300, mine: true }),
      comment("reply-root", { message: "root by other", createdAt_ms: 400 }),
      comment("reply-mine", {
        parentId: "reply-root",
        message: "my reply",
        mine: true,
        createdAt_ms: 500,
      }),
      comment("on-node", { message: "anchored", createdAt_ms: 600, nodeId: "1:2" }),
    ]);

  it("hides resolved threads by default and shows them when allowed", () => {
    expect(applyThreadFilters(threads(), base).map((t) => t.root.id)).not.toContain("done");
    expect(
      applyThreadFilters(threads(), { ...base, showResolved: true }).map((t) => t.root.id),
    ).toContain("done");
  });

  it("mineOnly keeps threads where the root or any reply carries a real mine flag", () => {
    const ids = applyThreadFilters(threads(), { ...base, mineOnly: true }).map((t) => t.root.id);
    expect([...ids].sort()).toEqual(["mine", "reply-root"].sort());
  });

  it("search matches message text or the real author handle, case-insensitively", () => {
    const byMessage = applyThreadFilters(threads(), { ...base, query: "  ANCHored  " });
    expect(byMessage.map((t) => t.root.id)).toEqual(["on-node"]);
    const byHandle = applyThreadFilters(threads(), {
      ...base,
      showResolved: true,
      query: "someone",
    });
    expect(byHandle.map((t) => t.root.id).sort()).toEqual(
      ["done", "mine", "on-node", "open", "reply-root"].sort(),
    );
    expect(applyThreadFilters(threads(), { ...base, query: "   " })).toEqual(
      applyThreadFilters(threads(), base),
    );
  });

  it("sorts by last activity in the requested direction", () => {
    const latest = applyThreadFilters(threads(), { ...base, showResolved: true, order: "latest" });
    const oldest = applyThreadFilters(threads(), { ...base, showResolved: true, order: "oldest" });
    expect(latest[0].lastActivity_ms).toBe(600);
    expect(oldest[0].lastActivity_ms).toBe(100);
    expect(oldest.map((t) => t.root.id)).toEqual(latest.map((t) => t.root.id).toReversed());
  });

  it("scopes to the root's anchor node when a node id is given", () => {
    expect(applyThreadFilters(threads(), { ...base, nodeId: "1:2" }).map((t) => t.root.id)).toEqual(
      ["on-node"],
    );
  });

  it("does not mutate the input array", () => {
    const input = threads();
    const snapshot = input.map((t) => t.root.id);
    applyThreadFilters(input, { ...base, order: "oldest" });
    expect(input.map((t) => t.root.id)).toEqual(snapshot);
  });
});
