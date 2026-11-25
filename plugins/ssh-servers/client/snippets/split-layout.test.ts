import { describe, expect, it } from "vitest";
import {
  PaneLimitError,
  closePane,
  computePaneRects,
  createWorkspace,
  focusNeighbor,
  fromTemplateLayout,
  inputTargets,
  paneIds,
  resizeSplit,
  splitPane,
  toTemplateLayout,
  toggleBroadcast,
  type PaneSpec,
} from "./split-layout";

function server(id: string): PaneSpec {
  return { id, target: { kind: "server", serverId: `srv_${id}` } };
}

describe("split workspace", () => {
  it("lays out panes in a near-square grid", () => {
    const workspace = createWorkspace(["a", "b", "c"].map(server));
    expect(paneIds(workspace)).toEqual(["a", "b", "c"]);
    const rects = computePaneRects(workspace);
    expect(rects.get("a")).toEqual({ x: 0, y: 0, width: 0.5, height: 0.5 });
    expect(rects.get("b")).toEqual({ x: 0.5, y: 0, width: 0.5, height: 0.5 });
    expect(rects.get("c")).toEqual({ x: 0, y: 0.5, width: 1, height: 0.5 });
    expect(workspace.focusedPaneId).toBe("a");
  });

  it("splits up to 16 panes and refuses the 17th", () => {
    let workspace = createWorkspace([server("p0")]);
    for (let i = 1; i < 16; i += 1) {
      workspace = splitPane(workspace, {
        paneId: workspace.focusedPaneId,
        direction: i % 2 === 0 ? "row" : "column",
        pane: server(`p${i}`),
      });
    }
    expect(paneIds(workspace)).toHaveLength(16);
    expect(() =>
      splitPane(workspace, { paneId: "p0", direction: "row", pane: server("p16") }),
    ).toThrow(PaneLimitError);
    const seventeen = Array.from({ length: 17 }, (_, i) => server(`x${i}`));
    expect(() => createWorkspace(seventeen)).toThrow(PaneLimitError);
  });

  it("joins a same-direction parent and halves the pane's share", () => {
    const workspace = splitPane(createWorkspace([server("a"), server("b")]), {
      paneId: "a",
      direction: "row",
      pane: server("c"),
    });
    expect(paneIds(workspace)).toEqual(["a", "c", "b"]);
    const rects = computePaneRects(workspace);
    expect(rects.get("a")?.width).toBe(0.25);
    expect(rects.get("c")?.width).toBe(0.25);
    expect(rects.get("b")?.width).toBe(0.5);
    expect(workspace.focusedPaneId).toBe("c");
  });

  it("collapses a split when closing leaves one child and moves focus", () => {
    let workspace = createWorkspace([server("a")]);
    workspace = splitPane(workspace, { paneId: "a", direction: "column", pane: server("b") });
    const closed = closePane(workspace, "b")!;
    expect(closed.rootId).toBe("a");
    expect(Object.keys(closed.nodes)).toEqual(["a"]);
    expect(closed.focusedPaneId).toBe("a");
    expect(closePane(closed, "a")).toBeNull();
  });

  it("moves focus to the adjacent pane in each direction", () => {
    const workspace = createWorkspace(["a", "b", "c", "d"].map(server));
    expect(focusNeighbor(workspace, "right").focusedPaneId).toBe("b");
    expect(focusNeighbor(workspace, "down").focusedPaneId).toBe("c");
    expect(focusNeighbor(workspace, "left").focusedPaneId).toBe("a");
    const fromD = { ...workspace, focusedPaneId: "d" };
    expect(focusNeighbor(fromD, "up").focusedPaneId).toBe("b");
    expect(focusNeighbor(fromD, "left").focusedPaneId).toBe("c");
  });

  it("broadcasts input to every pane only while broadcast is on", () => {
    const workspace = createWorkspace(["a", "b", "c"].map(server));
    expect(inputTargets(workspace, "b")).toEqual(["b"]);
    expect(inputTargets(toggleBroadcast(workspace), "b")).toEqual(["a", "b", "c"]);
  });

  it("clamps and renormalizes split sizes", () => {
    const workspace = createWorkspace([server("a"), server("b")]);
    const resized = resizeSplit(workspace, "row_0", [0.99, 0.01]);
    const split = resized.nodes.row_0;
    expect(split?.kind === "split" ? split.sizes : []).toEqual([0.99 / 1.04, 0.05 / 1.04]);
  });

  it("round-trips through the template layout", () => {
    const workspace = splitPane(createWorkspace(["a", "b", "c"].map(server)), {
      paneId: "c",
      direction: "row",
      pane: { id: "d", target: { kind: "local" }, tabTitle: "Local" },
    });
    const layout = toTemplateLayout(workspace);
    expect(layout.nodes[0]?.id).toBe(layout.rootId);
    const reopened = fromTemplateLayout(layout);
    expect(paneIds(reopened)).toEqual(paneIds(workspace));
    expect(computePaneRects(reopened)).toEqual(computePaneRects(workspace));
    expect(reopened.broadcast).toBe(false);
  });
});
