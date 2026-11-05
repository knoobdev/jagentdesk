import { describe, expect, it } from "vitest";
import {
  buildEditOps,
  createComponentOp,
  createInstanceOp,
  createNodeOp,
  deleteOp,
  duplicateOp,
  placementForCreate,
  renameOp,
  setReactionOp,
  toggleLockOp,
  toggleVisibleOp,
} from "./ops";
import { makeNode } from "./__fixtures__/figma";

describe("buildEditOps from inspect patches", () => {
  it("turns nothing into nothing", () => {
    expect(buildEditOps("1:1", {})).toEqual([]);
    expect(buildEditOps("1:1", { name: "   " })).toEqual([]);
  });

  it("maps simple properties one op each, in order", () => {
    const ops = buildEditOps("1:23", {
      name: "Hero",
      visible: false,
      locked: true,
      characters: "hello",
      cornerRadius: 8,
    });
    expect(ops).toEqual([
      { op: "rename", nodeId: "1:23", name: "Hero" },
      { op: "set_visible", nodeId: "1:23", visible: false },
      { op: "set_locked", nodeId: "1:23", locked: true },
      { op: "set_text", nodeId: "1:23", characters: "hello" },
      { op: "set_corner_radius", nodeId: "1:23", radius: 8 },
    ]);
  });

  it("collapses geometry into one set_geometry op with only the changed fields", () => {
    expect(buildEditOps("1:1", { x: 10, y: 20 })).toEqual([
      { op: "set_geometry", nodeId: "1:1", x: 10, y: 20, width: undefined, height: undefined },
    ]);
    const onlyWidth = buildEditOps("1:1", { width: 300 });
    expect(onlyWidth).toHaveLength(1);
    expect(onlyWidth[0]).toMatchObject({ op: "set_geometry", width: 300 });
  });

  it("converts a hex fill into Figma 0..1 rgba", () => {
    const ops = buildEditOps("1:1", { fillColor: "#ff8000" });
    expect(ops).toEqual([
      {
        op: "set_fill",
        nodeId: "1:1",
        color: { r: 1, g: 0.5019607843137255, b: 0, a: 1 },
      },
    ]);
    expect(() => buildEditOps("1:1", { fillColor: "#f00" })).toThrow(/hex/);
  });

  it("accepts a literal FigmaColor", () => {
    const color = { r: 0, g: 0, b: 0, a: 0.5 };
    expect(buildEditOps("1:1", { fillColor: color })[0]).toEqual({
      op: "set_fill",
      nodeId: "1:1",
      color,
    });
  });

  it("collapses auto layout fields into one set_auto_layout op", () => {
    const ops = buildEditOps("1:1", {
      layoutMode: "VERTICAL",
      itemSpacing: 12,
      padding: { top: 8, right: 8, bottom: 8, left: 8 },
      primaryAxisSizingMode: "AUTO",
    });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual({
      op: "set_auto_layout",
      nodeId: "1:1",
      layoutMode: "VERTICAL",
      itemSpacing: 12,
      padding: { top: 8, right: 8, bottom: 8, left: 8 },
      primaryAxisSizingMode: "AUTO",
    });
  });

  it("emits set_layout_child only for child sizing", () => {
    expect(buildEditOps("1:1", { childHorizontal: "FILL" })).toEqual([
      { op: "set_layout_child", nodeId: "1:1", horizontal: "FILL" },
    ]);
    expect(buildEditOps("1:1", { width: 10 })).toEqual([
      {
        op: "set_geometry",
        nodeId: "1:1",
        x: undefined,
        y: undefined,
        width: 10,
        height: undefined,
      },
    ]);
  });
});

describe("toolbar ops (32.6)", () => {
  it("toggles visibility from the node's current state", () => {
    expect(toggleVisibleOp(makeNode({ id: "1:1", visible: false }))).toEqual({
      op: "set_visible",
      nodeId: "1:1",
      visible: true,
    });
    expect(toggleVisibleOp(makeNode({ id: "1:2" }))).toEqual({
      op: "set_visible",
      nodeId: "1:2",
      visible: false,
    });
  });

  it("toggles the lock, reading either lock encoding Figma returns", () => {
    expect(toggleLockOp(makeNode({ id: "1:1", locked: true }))).toEqual({
      op: "set_locked",
      nodeId: "1:1",
      locked: false,
    });
    expect(toggleLockOp(makeNode({ id: "1:2", constraints: "LOCKED" }))).toEqual({
      op: "set_locked",
      nodeId: "1:2",
      locked: false,
    });
  });

  it("builds delete / duplicate / rename / create ops", () => {
    expect(deleteOp("9:9")).toEqual({ op: "delete", nodeId: "9:9" });
    expect(duplicateOp("9:9", "tmp-1")).toEqual({
      op: "duplicate",
      nodeId: "9:9",
      tempId: "tmp-1",
    });
    expect(renameOp("9:9", "Nav")).toEqual({ op: "rename", nodeId: "9:9", name: "Nav" });
    expect(
      createNodeOp({
        parentId: "0:1",
        kind: "RECTANGLE",
        tempId: "tmp-2",
        x: 0,
        y: 0,
        width: 100,
        height: 50,
      }),
    ).toEqual({
      op: "create_node",
      parentId: "0:1",
      kind: "RECTANGLE",
      tempId: "tmp-2",
      x: 0,
      y: 0,
      width: 100,
      height: 50,
    });
    expect(createComponentOp("1:5", "cmp-1")).toEqual({
      op: "create_component",
      nodeId: "1:5",
      tempId: "cmp-1",
    });
    expect(
      createInstanceOp({ componentId: "1:5", parentId: "0:1", x: 4, y: 4, tempId: "i-1" }),
    ).toEqual({
      op: "create_instance",
      componentId: "1:5",
      parentId: "0:1",
      x: 4,
      y: 4,
      tempId: "i-1",
    });
  });

  it("sets and clears reactions", () => {
    expect(setReactionOp({ nodeId: "1:1", trigger: "ON_CLICK", destinationId: "2:2" })).toEqual({
      op: "set_reaction",
      nodeId: "1:1",
      trigger: "ON_CLICK",
      destinationId: "2:2",
    });
    expect(
      setReactionOp({
        nodeId: "1:1",
        trigger: "ON_HOVER",
        destinationId: null,
        transition: { type: "DISSOLVE", durationMs: 200 },
      }),
    ).toMatchObject({ op: "set_reaction", destinationId: null });
  });

  it("places created nodes centered in the visible region", () => {
    expect(
      placementForCreate({ x: 0, y: 0, width: 800, height: 600 }, { width: 240, height: 140 }),
    ).toEqual({ x: 280, y: 230 });
    expect(
      placementForCreate({ x: -100, y: 50, width: 500, height: 300 }, { width: 100, height: 100 }),
    ).toEqual({ x: 100, y: 150 });
  });
});
