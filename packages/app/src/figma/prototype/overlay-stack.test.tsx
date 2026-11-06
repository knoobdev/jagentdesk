/**
 * @vitest-environment jsdom
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";

const { theme, frameStageCalls } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 1.5: 6, 2: 8, 3: 12, 4: 16, 6: 24 },
    fontSize: { xs: 11, sm: 13, base: 15 },
    fontWeight: { normal: "400", semibold: "600" },
    borderRadius: { sm: 4, md: 6, lg: 8, full: 9999 },
    borderWidth: { 1: 1 },
    colors: {
      surface0: "#111",
      surface1: "#161616",
      surfaceWorkspace: "#0a0a0a",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#333",
      accent: "#2563eb",
    },
  },
  frameStageCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  withUnistyles: (component: unknown) => component,
  useUnistyles: () => ({ theme }),
}));
vi.mock("@/runtime/host-runtime", () => ({ useHostRuntimeClient: () => null }));
vi.mock("@/data/query", () => ({ useFetchQuery: () => ({ data: undefined }) }));
vi.mock("@/utils/open-external-url", () => ({ openExternalUrl: vi.fn() }));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("button", { type: "button" }, children),
}));
vi.mock("@/components/ui/loading-spinner", () => ({
  LoadingSpinner: () => React.createElement("div", { "data-spinner": true }),
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children?: React.ReactNode }) => children,
  DropdownMenuTrigger: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
  DropdownMenuContent: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
  DropdownMenuItem: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
}));
vi.mock("@/components/ui/switch", () => ({
  Switch: () => React.createElement("input", { type: "checkbox" }),
}));
vi.mock("./frame-stage", () => ({
  FrameStage: (props: Record<string, unknown>) => {
    frameStageCalls.push(props);
    const root = props.root as { id?: string } | undefined;
    return React.createElement("div", { "data-frame-stage": String(root?.id ?? "") });
  },
}));

import { indexInteractions, type InteractionMap } from "./interactions";
import type { StageSpace } from "./frame-stage";
import { interaction, node } from "./test-support/frames";
import type { OverlayEntry } from "./state-machine";
import type { FrameLookup } from "./use-frames";
import { OverlayStack } from "./prototype-player";
import { nodeBounds, type Rect } from "./node-geometry";

// G5 bugs 1–2: the overlay sheet must render at the BASE frame's scale/origin (not fitted to
// the whole stage, which drew it at 1.0 over a ~0.67 frame), must be positioned per the overlay
// settings, and must not be the thing hiding the base frame behind a flat backdrop.

const file = { serverId: "s1", fileKey: "fk1" };
// 900x1600 base in a 600x900 stage fits at min(2/3, 9/16) = 0.5625 — nowhere near 1.0.
const baseNode = node({ id: "2:1", name: "Product", width: 900, height: 1600 });
const sheetNode = node({ id: "9:1", name: "Added to cart", width: 375, height: 260 });
const stage = { width: 600, height: 900 };
const base: Rect = { x: 0, y: 0, width: 900, height: 1600 };

function lookupFor(nodes: FigmaNode[]): FrameLookup {
  return {
    loading: false,
    error: null,
    prototype: null,
    retry: () => undefined,
    nodeFor: (id) => nodes.find((candidate) => candidate.id === id) ?? null,
  };
}

function entry(overrides: Partial<OverlayEntry["settings"]> = {}, frameId = "9:1"): OverlayEntry {
  return {
    frameId,
    settings: {
      position: "BOTTOM_CENTER",
      dimColor: "rgba(0, 0, 0, 0.5)",
      closeOnClickOutside: true,
      ...overrides,
    },
  };
}

function renderStack(
  overlays: OverlayEntry[],
  overrides: {
    base?: Rect | null;
    nodes?: FigmaNode[];
    interactions?: InteractionMap;
    showHotspots?: boolean;
  } = {},
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onTrigger = vi.fn();
  actRender(() =>
    root.render(
      <OverlayStack
        file={file}
        frames={lookupFor(overrides.nodes ?? [baseNode, sheetNode])}
        overlays={overlays}
        stage={stage}
        base={"base" in overrides ? (overrides.base ?? null) : base}
        interactions={overrides.interactions ?? new Map()}
        showHotspots={overrides.showHotspots ?? true}
        onTrigger={onTrigger}
        onDismiss={vi.fn()}
      />,
    ),
  );
  return { container, onTrigger };
}

function actRender(fn: () => void) {
  const reactAct = (React as { act?: (fn: () => void) => void }).act;
  if (reactAct) reactAct(fn);
  else fn();
}

describe("OverlayStack placement (G5 bugs 1–2)", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    document.body.innerHTML = "";
    frameStageCalls.length = 0;
  });

  it("draws the sheet at the base frame's scale, not fitted to the whole stage", () => {
    renderStack([entry()]);
    expect(frameStageCalls).toHaveLength(1);
    const props = frameStageCalls[0];
    const scale = Math.min(600 / 900, 900 / 1600);
    expect(props.width).toBeCloseTo(375 * scale, 6);
    expect(props.height).toBeCloseTo(260 * scale, 6);
    // Regression guard: the old layer passed the raw stage box (600x900 → the sheet fitted
    // itself at 1.0 while the base sat at 0.5625).
    expect(props.width).not.toBe(600);
    expect(props.height).not.toBe(900);
  });

  it("positions the sheet inside the base rect per the overlay position", () => {
    const { container } = renderStack([entry()]);
    const sheet = container.querySelector('[data-testid="figma-overlay-sheet-9:1"]') as HTMLElement;
    expect(sheet).not.toBeNull();
    const scale = Math.min(600 / 900, 900 / 1600);
    // BOTTOM_CENTER: centred horizontally on the base rect, bottom edge flush with its bottom.
    const baseX = (600 - 900 * scale) / 2;
    const baseY = (900 - 1600 * scale) / 2;
    expect(parseFloat(sheet.style.left)).toBeCloseTo(baseX + ((900 - 375) * scale) / 2, 1);
    expect(parseFloat(sheet.style.top)).toBeCloseTo(baseY + (1600 - 260) * scale, 1);
  });

  it("keeps the base frame's own stage visible: the sheet covers its rect, not the stage", () => {
    const { container } = renderStack([entry()]);
    const sheet = container.querySelector('[data-testid="figma-overlay-sheet-9:1"]') as HTMLElement;
    expect(sheet).not.toBeNull();
    const scale = Math.min(600 / 900, 900 / 1600);
    // The sheet must not span the stage — an overlay-sized box leaves the base frame painted.
    const width = parseFloat(sheet.style.width || "0");
    expect(width).toBeLessThan(600);
    expect(width).toBeCloseTo(375 * scale, 1);
  });

  it("dims the backdrop with the overlay settings' dim color", () => {
    const { container } = renderStack([entry()]);
    const host = container.querySelector('[data-testid="figma-overlay-host-9:1"]') as HTMLElement;
    expect(host).not.toBeNull();
    expect(host.style.backgroundColor.replace(/\s+/g, " ")).toContain("rgba(0, 0, 0, 0.5)");
  });

  it("paints no dim when the overlay settings say the backdrop is clear", () => {
    const { container } = renderStack([entry({ dimColor: "" })]);
    const host = container.querySelector('[data-testid="figma-overlay-host-9:1"]') as HTMLElement;
    expect(host.style.backgroundColor).toBe("");
  });

  it("stacks overlays in order — the newest sheet paints above the earlier ones", () => {
    const sheet2 = node({ id: "9:2", name: "Confirm", width: 300, height: 200 });
    const { container } = renderStack([entry(), entry({}, "9:2")], {
      nodes: [baseNode, sheetNode, sheet2],
    });
    const sheets = [...container.querySelectorAll('[data-testid^="figma-overlay-sheet-"]')];
    expect(sheets).toHaveLength(2);
    // Later in the DOM = later in the stack = painted on top.
    expect(
      sheets[0].compareDocumentPosition(sheets[1]) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(frameStageCalls.map((props) => (props.root as FigmaNode).id)).toEqual(["9:1", "9:2"]);
  });

  it("renders no sheet until the base frame is on stage (it must sit on the base, not the stage)", () => {
    const { container } = renderStack([entry()], { base: null });
    expect(container.querySelector('[data-testid^="figma-overlay-sheet-"]')).toBeNull();
    expect(frameStageCalls).toHaveLength(0);
  });
});

// G5 r2: hotspots inside an open overlay ride the same HotspotsLayer the base frame uses,
// handed to the sheet's FrameStage so the hit targets share its space (placement scale +
// offset) and a press on the sheet runs the interaction's action.
describe("OverlayStack hotspots inside overlays (G5 r2)", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    frameStageCalls.length = 0;
  });

  const cartBtn = node({
    id: "9:2",
    name: "View cart",
    x: 1216,
    y: 1040,
    width: 343,
    height: 44,
  });
  const keepBtn = node({
    id: "9:3",
    name: "Keep shopping",
    x: 1216,
    y: 1100,
    width: 343,
    height: 44,
  });
  const sheetWithHotspots = node({
    id: "9:1",
    name: "Added to cart",
    x: 1200,
    y: 900,
    width: 375,
    height: 260,
    children: [cartBtn, keepBtn],
  });
  const cartInteractions = indexInteractions([
    interaction(
      "9:2",
      { type: "ON_CLICK" },
      { type: "NODE", navigation: "NAVIGATE", destinationId: "2:1" },
    ),
    interaction("9:3", { type: "ON_CLICK" }, { type: "CLOSE" }),
  ]);

  // Sheet-local space like the sheet's FrameStage hands its renderOverlay: scale about the
  // sheet origin. Scale 1 here — the pure overlayHitRect test pins the mapping numbers.
  function sheetSpace(): StageSpace {
    return {
      scale: 1,
      boxOf: (n: FigmaNode) => nodeBounds(n),
    };
  }

  it("hands the sheet's FrameStage a hotspot renderer that maps and fires overlay hotspots", () => {
    const { onTrigger } = renderStack([entry()], {
      nodes: [baseNode, sheetWithHotspots],
      interactions: cartInteractions,
    });
    const sheetCall = frameStageCalls.at(-1) as Record<string, unknown>;
    const renderOverlay = sheetCall.renderOverlay as
      | ((space: StageSpace) => React.ReactNode)
      | undefined;
    expect(typeof renderOverlay).toBe("function");

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    actRender(() => root.render(<>{renderOverlay!(sheetSpace())}</>));
    const buttons = [...container.querySelectorAll<HTMLElement>("[role='button']")];
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(
      expect.arrayContaining(["View cart", "Keep shopping"]),
    );

    const viewCart = buttons.find((b) => b.getAttribute("aria-label") === "View cart")!;
    actRender(() => {
      viewCart.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "9:2",
        trigger: "ON_CLICK",
        action: expect.objectContaining({ kind: "navigate" }),
      }),
    );
  });

  it("renders no hotspot renderer when hotspots are off", () => {
    renderStack([entry()], {
      nodes: [baseNode, sheetWithHotspots],
      interactions: cartInteractions,
      showHotspots: false,
    });
    const sheetCall = frameStageCalls.at(-1) as Record<string, unknown>;
    expect(sheetCall.renderOverlay).toBeUndefined();
  });
});
