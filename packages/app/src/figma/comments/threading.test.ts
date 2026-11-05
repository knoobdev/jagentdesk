import { describe, expect, it } from "vitest";
import { buildThreads, filterThreadsByNode, threadsForNode, toggleReaction } from "./threading";
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
