import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  FigmaEditOp,
  FigmaNode,
  FigmaPendingOp,
} from "@jagentdesk/protocol/figma/rpc-schemas";
import { FigmaServiceError } from "./context.js";
import {
  addPendingOps,
  applyPendingOps,
  discardPendingOps,
  loadPendingOps,
  pendingQueuePath,
  remapTempIds,
  removePendingOp,
} from "./pending.js";
import {
  FakeFigmaLink,
  FakeFigmaRest,
  FakeFigmaStore,
  fakeFigmaContext,
  fakeFile,
} from "./test-support/fake-figma-queue.js";
import type { FigmaContext } from "./context.js";
import type { FigmaPush } from "@jagentdesk/protocol/figma/rpc-schemas";

// Edit queue (spec 32.6.1): add stores baseVersion + previous values; apply requires Figma Link,
// checks every op against the live node, and keeps conflicts for Keep mine / Keep Figma.

const logger = pino({ level: "silent" });
let home: string;
let ctx: FigmaContext;
let pushes: FigmaPush[];
let store: FakeFigmaStore;
let rest: FakeFigmaRest;
let link: FakeFigmaLink;

const FILE_KEY = "AbC123xyz";

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "jad-figma-pending-"));
  store = new FakeFigmaStore();
  rest = new FakeFigmaRest();
  link = new FakeFigmaLink();
  ({ ctx, pushes } = fakeFigmaContext({ jagentdeskHome: home, logger, store, rest, link }));
  void store.saveFile(fakeFile({ fileKey: FILE_KEY, lastVersion: "171:2", lastModified_ms: 1 }));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function renameOp(name: string): FigmaEditOp {
  return { op: "rename", nodeId: "1:1", name };
}

describe("figma edit queue", () => {
  it("queues ops with baseVersion and the previous values read from REST", async () => {
    rest.reply(`/v1/files/${FILE_KEY}/nodes`, {
      nodes: { "1:1": { document: { id: "1:1", name: "Old", type: "RECTANGLE" } } },
    });
    const created = await addPendingOps(ctx, FILE_KEY, [renameOp("New")], "user");

    expect(created).toHaveLength(1);
    expect(created[0]!.id).toMatch(/^fpo_[0-9a-f]{12}$/);
    expect(created[0]!.baseVersion).toBe("171:2");
    expect(created[0]!.previous).toEqual({ name: "Old" });
    expect(created[0]!.state).toBe("pending");
    expect(created[0]!.origin).toBe("user");
    expect(created[0]!.createdAt_ms).toBe(1_700_000_000_000);

    // Persisted atomically under $JAGENTDESK_HOME/figma/pending/<fileKey>.json.
    const raw = JSON.parse(readFileSync(pendingQueuePath(home, FILE_KEY), "utf8"));
    expect(raw.fileKey).toBe(FILE_KEY);
    expect(raw.ops).toHaveLength(1);
    expect(pushes).toContainEqual({ type: "figma.pending.changed", fileKey: FILE_KEY, count: 1 });
  });

  it("prefers the Link's live values for previous reads when the file is linked", async () => {
    link.setLinked(FILE_KEY);
    link.setNode(FILE_KEY, { id: "1:1", name: "ViaLink", type: "RECTANGLE" });
    const created = await addPendingOps(ctx, FILE_KEY, [renameOp("New")], "agent");
    expect(created[0]!.previous).toEqual({ name: "ViaLink" });
    expect(created[0]!.origin).toBe("agent");
    expect(rest.calls).toHaveLength(0);
  });

  it("queues without previous values when neither Link nor REST can read the node", async () => {
    const created = await addPendingOps(ctx, FILE_KEY, [renameOp("New")], "user");
    expect(created[0]!.previous).toEqual({});
  });

  it("lists in queue order, removes one op, and discards all", async () => {
    const a = await addPendingOps(ctx, FILE_KEY, [renameOp("A")], "user");
    const b = await addPendingOps(ctx, FILE_KEY, [renameOp("B")], "user");
    expect((await loadPendingOps(ctx, FILE_KEY)).map((o) => o.id)).toEqual([a[0]!.id, b[0]!.id]);

    await removePendingOp(ctx, FILE_KEY, a[0]!.id);
    expect((await loadPendingOps(ctx, FILE_KEY)).map((o) => o.id)).toEqual([b[0]!.id]);

    await discardPendingOps(ctx, FILE_KEY);
    expect(await loadPendingOps(ctx, FILE_KEY)).toEqual([]);
    expect(pushes.at(-1)).toEqual({ type: "figma.pending.changed", fileKey: FILE_KEY, count: 0 });
    expect(() => readFileSync(pendingQueuePath(home, FILE_KEY), "utf8")).toThrow();
  });

  it("rejects removing an unknown op and an invalid file key", async () => {
    await addPendingOps(ctx, FILE_KEY, [renameOp("A")], "user");
    await expect(removePendingOp(ctx, FILE_KEY, "fpo_missing")).rejects.toMatchObject({
      code: "invalid_input",
    });
    await expect(addPendingOps(ctx, "bad/key", [renameOp("A")], "user")).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  it("apply requires the file to be linked", async () => {
    await addPendingOps(ctx, FILE_KEY, [renameOp("A")], "user");
    const error = await applyPendingOps(ctx, FILE_KEY).catch((e) => e);
    expect(error).toBeInstanceOf(FigmaServiceError);
    expect((error as FigmaServiceError).code).toBe("link_unavailable");
  });

  it("applies non-conflicting ops through the plugin and removes them", async () => {
    await addPendingOps(ctx, FILE_KEY, [renameOp("New")], "user");
    link.setLinked(FILE_KEY);
    link.setNode(FILE_KEY, { id: "1:1", name: "Old", type: "RECTANGLE" });

    const remaining = await applyPendingOps(ctx, FILE_KEY);
    expect(remaining).toEqual([]);
    expect(link.applied).toHaveLength(1);
    expect(link.applied[0]!.ops).toEqual([renameOp("New")]);
    expect(await loadPendingOps(ctx, FILE_KEY)).toEqual([]);
    expect(pushes.at(-1)).toEqual({ type: "figma.pending.changed", fileKey: FILE_KEY, count: 0 });
  });

  it("marks conflict when the live value differs from the stored previous value", async () => {
    rest.reply(`/v1/files/${FILE_KEY}/nodes`, {
      nodes: { "1:1": { document: { id: "1:1", name: "Old", type: "RECTANGLE" } } },
    });
    await addPendingOps(ctx, FILE_KEY, [renameOp("New")], "user");
    link.setLinked(FILE_KEY);
    link.setNode(FILE_KEY, { id: "1:1", name: "EditedInFigma", type: "RECTANGLE" });

    const remaining = await applyPendingOps(ctx, FILE_KEY);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.state).toBe("conflict");
    expect(remaining[0]!.message).toBe("Changed in Figma since you edited");
    // The conflicting op never reached the plugin.
    expect(link.applied).toHaveLength(0);
  });

  it("keep_mine applies the op over the Figma change", async () => {
    rest.reply(`/v1/files/${FILE_KEY}/nodes`, {
      nodes: { "1:1": { document: { id: "1:1", name: "Old", type: "RECTANGLE" } } },
    });
    const [entry] = await addPendingOps(ctx, FILE_KEY, [renameOp("New")], "user");
    link.setLinked(FILE_KEY);
    link.setNode(FILE_KEY, { id: "1:1", name: "EditedInFigma", type: "RECTANGLE" });

    const remaining = await applyPendingOps(ctx, FILE_KEY, { [entry!.id]: "keep_mine" });
    expect(remaining).toEqual([]);
    expect(link.applied[0]!.ops).toEqual([renameOp("New")]);
  });

  it("keep_figma drops the op without applying it", async () => {
    rest.reply(`/v1/files/${FILE_KEY}/nodes`, {
      nodes: { "1:1": { document: { id: "1:1", name: "Old", type: "RECTANGLE" } } },
    });
    const [entry] = await addPendingOps(ctx, FILE_KEY, [renameOp("New")], "user");
    link.setLinked(FILE_KEY);
    link.setNode(FILE_KEY, { id: "1:1", name: "EditedInFigma", type: "RECTANGLE" });

    const remaining = await applyPendingOps(ctx, FILE_KEY, { [entry!.id]: "keep_figma" });
    expect(remaining).toEqual([]);
    expect(link.applied).toHaveLength(0);
    expect(pushes.at(-1)).toEqual({ type: "figma.pending.changed", fileKey: FILE_KEY, count: 0 });
  });

  it("treats a vanished node as a conflict", async () => {
    rest.reply(`/v1/files/${FILE_KEY}/nodes`, {
      nodes: { "1:1": { document: { id: "1:1", name: "Old", type: "RECTANGLE" } } },
    });
    await addPendingOps(ctx, FILE_KEY, [renameOp("New")], "user");
    link.setLinked(FILE_KEY); // no node in the link tree → getNodes returns null

    const remaining = await applyPendingOps(ctx, FILE_KEY);
    expect(remaining[0]!.state).toBe("conflict");
  });

  it("keeps plugin-rejected ops as failed with the plugin message", async () => {
    await addPendingOps(ctx, FILE_KEY, [renameOp("New")], "user");
    link.setLinked(FILE_KEY);
    link.setNode(FILE_KEY, { id: "1:1", name: "Old", type: "RECTANGLE" });
    link.failOps["rename:1:1"] = "node is locked";

    const remaining = await applyPendingOps(ctx, FILE_KEY);
    expect(remaining[0]!.state).toBe("failed");
    expect(remaining[0]!.message).toBe("node is locked");
  });

  it("maps tempIds of created nodes into the ops left in the queue", async () => {
    const created = await addPendingOps<FigmaPendingOp>(
      ctx,
      FILE_KEY,
      [
        {
          op: "create_node",
          parentId: "0:1",
          kind: "TEXT",
          tempId: "tmp_a",
          x: 0,
          y: 0,
          width: 10,
          height: 10,
        },
      ],
      "user",
    );
    // A second op references the tempId and conflicts, so it stays in the queue.
    rest.reply(`/v1/files/${FILE_KEY}/nodes`, {
      nodes: {
        tmp_a: { document: { id: "tmp_a", name: "Ghost", type: "TEXT", characters: "live" } },
      },
    });
    const [second] = await addPendingOps(
      ctx,
      FILE_KEY,
      [{ op: "set_text", nodeId: "tmp_a", characters: "mine" }],
      "user",
    );
    expect(created).toHaveLength(1);

    link.setLinked(FILE_KEY);
    link.setNode(FILE_KEY, {
      id: "tmp_a",
      name: "Ghost",
      type: "TEXT",
      characters: "edited in figma",
    });

    const remaining = await applyPendingOps(ctx, FILE_KEY);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe(second!.id);
    expect(remaining[0]!.state).toBe("conflict");
    expect(remaining[0]!.op).toEqual({ op: "set_text", nodeId: "99:1", characters: "mine" });
  });
});

describe("remapTempIds", () => {
  it("replaces tempIds in every string field of an op", () => {
    const op: FigmaEditOp = {
      op: "set_reaction",
      nodeId: "tmp_a",
      trigger: "ON_CLICK",
      destinationId: "tmp_b",
    };
    expect(remapTempIds(op, { tmp_a: "9:1", tmp_b: "9:2" })).toEqual({
      op: "set_reaction",
      nodeId: "9:1",
      trigger: "ON_CLICK",
      destinationId: "9:2",
    });
  });

  it("leaves ops untouched when nothing was created", () => {
    const op: FigmaEditOp = { op: "rename", nodeId: "1:1", name: "n" };
    expect(remapTempIds(op, {})).toBe(op);
  });
});

describe("queue conflict comparison", () => {
  it("does not flag a conflict when only key order in the stored value differs", async () => {
    const paint = {
      fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } }],
    };
    rest.reply(`/v1/files/${FILE_KEY}/nodes`, {
      nodes: { "1:1": { document: { id: "1:1", name: "R", type: "RECTANGLE", ...paint } } },
    });
    await addPendingOps(
      ctx,
      FILE_KEY,
      [{ op: "set_fill", nodeId: "1:1", color: { r: 0, g: 1, b: 0, a: 1 } }],
      "user",
    );
    link.setLinked(FILE_KEY);
    // Same values, different key order — must not be a conflict.
    const reordered: FigmaNode = {
      id: "1:1",
      name: "R",
      type: "RECTANGLE",
      fills: [{ color: { a: 1, b: 0, g: 0, r: 1 }, type: "SOLID" }],
    };
    link.setNode(FILE_KEY, reordered);

    const remaining = await applyPendingOps(ctx, FILE_KEY);
    expect(remaining).toEqual([]);
    expect(link.applied[0]!.ops).toEqual([
      { op: "set_fill", nodeId: "1:1", color: { r: 0, g: 1, b: 0, a: 1 } },
    ]);
  });
});
