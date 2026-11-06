/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { router } from "expo-router"; // the hoisted mock — used to assert param writes

const {
  theme,
  captured,
  queueOverrides,
  editsState,
  features,
  hooks,
  routeParams,
  remote,
  figmaFns,
  outlineFixture,
} = vi.hoisted(() => {
  const uiTheme = {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
    colors: {
      surface0: "#0a0a0a",
      surface1: "#111",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      foregroundExtraMuted: "#777",
      border: "#555",
      accent: "#0a84ff",
      statusDanger: "#ff0000",
      palette: { red: { 300: "#ff6b6b" }, white: "#fff" },
    },
  };
  const outline = {
    name: "Design file",
    // ADR-0039: even live asset paths must pin to the outline snapshot version.
    version: "snap-1",
    pages: [
      {
        id: "p1",
        name: "Page 1",
        frames: [
          {
            id: "1:1",
            name: "Screen",
            type: "FRAME",
            bounds: { x: 0, y: 0, width: 375, height: 812 },
          },
          // Spec 32.6.2: a SECTION root the write-path tests drag.
          {
            id: "40:1",
            name: "Flow Board",
            type: "SECTION",
            bounds: { x: 10, y: 20, width: 1000, height: 800 },
          },
        ],
        children: [],
        flowStartingPoints: [{ nodeId: "9:9", name: "Onboarding", pageId: "p1" }],
      },
      {
        id: "p2",
        name: "Page 2",
        frames: [
          {
            id: "60:1",
            name: "Other screen",
            type: "FRAME",
            bounds: { x: 0, y: 900, width: 375, height: 812 },
          },
        ],
        children: [],
        flowStartingPoints: [],
      },
    ],
  };
  const queue = { "1:1": { name: "Queued" } } as Record<string, unknown>;
  const edits = {
    current: {
      linked: false,
      pendingCount: 1,
      overrides: {} as Record<string, unknown>,
      applyEdits: vi.fn(async () => undefined),
      applyPending: vi.fn(() => Promise.resolve()),
      discardPending: vi.fn(() => Promise.resolve()),
    },
  };
  // The lazy store as the screen sees it: a cached parent chain 1:5 → 1:4 → 1:1 lets the W6
  // handoff test assert the player gets the ROOT FRAME, not the selected text/button node.
  const parentLinks: Record<string, { id: string; name: string; type: string }> = {
    "1:5": { id: "1:4", name: "Group", type: "GROUP" },
    "1:4": { id: "1:1", name: "Screen", type: "FRAME" },
  };
  const store = {
    subscribe: vi.fn(() => vi.fn()),
    parentOf: vi.fn((id: string) => parentLinks[id] ?? null),
    componentMeta: vi.fn(() => undefined),
    // nodeFocusBounds walks loaded roots; the shared mock keeps none (frame summaries cover
    // known layers, and unknown ones fall through to the Tier-1 nodes RPC, as intended).
    loadedIds: vi.fn(() => [] as string[]),
    get: vi.fn(() => null),
  };
  return {
    theme: uiTheme,
    // Props the screen hands the toolbar / inspect panel / canvas / player — the wiring.
    captured: {
      toolbar: null as Record<string, unknown> | null,
      inspect: null as Record<string, unknown> | null,
      canvas: null as Record<string, unknown> | null,
      player: null as Record<string, unknown> | null,
      topbar: null as Record<string, unknown> | null,
      // Plain-View onLayout handlers (the canvas area's size callback) so tests can deliver a
      // real layout pass — the URL-node focus effect is gated on a measured canvas.
      layouts: [] as Array<
        (event: { nativeEvent: { layout: { width: number; height: number } } }) => void
      >,
    },
    outlineFixture: outline,
    queueOverrides: queue,
    editsState: edits,
    // The daemon capabilities the gate reads (ADR-0039 / spec 32.5.1). Tests flip these; the
    // base `figma` gate must stay compatible with the pre-ADR behaviour.
    features: {
      current: { figma: true, figmaNodeDepth: true } as Record<string, boolean>,
    },
    // The inner screen's data path. The capability gate must keep ALL of these unmounted —
    // a new client never sends depth1 to an old host, and there is no full-Section fallback.
    hooks: {
      outline: vi.fn(() => ({ data: outline, isPending: false, isError: false, error: null })),
      edits: vi.fn(() => edits.current),
      frameStore: vi.fn(() => store),
      watch: vi.fn(),
    },
    // Route params feed the initial selection (decoded by ./node-url, the real pure module).
    routeParams: { current: {} as Record<string, string | string[]> },
    storeMock: store,
    // The remote write surface (ADR-0040): W10's connector-status hook answer + the execute
    // RPC, both fully controlled per test.
    remote: {
      statusData: null as { state: string } | null,
      statusCalls: [] as Array<Record<string, unknown>>,
      execute: vi.fn(),
    },
    figmaFns: {
      invalidateFile: vi.fn(),
      invalidateQueries: vi.fn(),
    },
  };
});

// The pending queue RPC promises are the whole point of this wiring test: the callbacks the
// screen passes to the toolbar must be the live promises (the toolbar surfaces their
// rejections), not voided calls.
vi.mock("react-native", () => ({
  Platform: { OS: "web" },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  View: ({
    children,
    testID,
    onLayout,
  }: {
    children?: React.ReactNode;
    testID?: string;
    onLayout?: (event: { nativeEvent: { layout: { width: number; height: number } } }) => void;
  }) => {
    if (onLayout) captured.layouts.push(onLayout);
    return React.createElement("div", { "data-testid": testID }, children);
  },
  Text: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("span", null, children),
  Pressable: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
  },
  useUnistyles: () => ({ theme, rt: { breakpoint: "md" } }),
  withUnistyles: <T,>(component: T) => component,
}));

vi.mock("@/constants/platform", () => ({ isWeb: true, isNative: false }));
vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => false }));
vi.mock("@/runtime/host-features", () => ({
  useHostFeature: (_serverId: string | null | undefined, feature: string) =>
    Boolean(features.current[feature]),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: figmaFns.invalidateQueries }),
}));
vi.mock("expo-router", () => ({
  router: {
    // REALISTIC merge semantics: a param write updates the location that
    // useLocalSearchParams reads back — the echo the component must survive (#185).
    setParams: vi.fn(async (patch: Record<string, string | string[]>) => {
      Object.assign(routeParams.current, patch);
    }),
    replace: vi.fn(async () => undefined),
  },
  useLocalSearchParams: () => routeParams.current,
}));
vi.mock("@/jira/ui/styles", () => {
  const style = new Proxy({}, { get: () => ({}) });
  return { jiraStyles: style };
});
vi.mock("@/jira/ui/primitives", () => ({
  EmptyState: () => React.createElement("div", { "data-testid": "empty-state" }),
  ErrorBanner: ({ message }: { message: string }) =>
    React.createElement("span", { "data-testid": "error-banner" }, message),
  Tabs: () => React.createElement("div", null),
}));
vi.mock("@/components/ui/loading-spinner", () => ({ LoadingSpinner: () => null }));
vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({ children }: { children?: React.ReactNode }) => children,
}));
vi.mock("lucide-react-native", () => {
  const icon = () => () => React.createElement("i");
  return { PanelRightClose: icon(), PanelRightOpen: icon(), Sparkles: icon() };
});
vi.mock("./api", () => ({
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  useFigmaCall: () => (type: string, params: unknown) =>
    type === "figma.remote.execute.request"
      ? remote.execute(params as { fileKey: string; code: string; description: string })
      : Promise.resolve({ nodes: {} }),
}));
vi.mock("../queries", () => ({
  // The connector state the screen reads comes from W10's hook verbatim; the tests drive it
  // through `remote.statusData` and assert the capability gate via the recorded `enabled` option.
  useFigmaRemoteStatus: (_serverId: string, options: Record<string, unknown>) => {
    remote.statusCalls.push(options);
    return { data: remote.statusData };
  },
}));
vi.mock("./use-figma-file", () => ({
  figmaKeys: { all: () => ["figma"] },
  invalidateFigmaFile: figmaFns.invalidateFile,
  useFigmaOutline: hooks.outline,
  useFigmaEdits: hooks.edits,
  useFigmaFrameStore: hooks.frameStore,
  useFigmaWatch: hooks.watch,
}));
vi.mock("./canvas-view", () => ({
  CanvasView: (props: Record<string, unknown>) => {
    captured.canvas = props;
    return React.createElement("div", { "data-testid": "canvas-view" });
  },
  findNodeInStore: () => null,
}));
vi.mock("./edit-toolbar", () => ({
  EditToolbar: (props: Record<string, unknown>) => {
    captured.toolbar = props;
    return React.createElement("div", { "data-testid": "edit-toolbar" });
  },
}));
vi.mock("./inspect-panel", () => ({
  InspectPanel: (props: Record<string, unknown>) => {
    captured.inspect = props;
    return React.createElement("div", { "data-testid": "inspect-panel" });
  },
}));
vi.mock("./top-bar", () => ({
  FigmaTopBar: (props: Record<string, unknown>) => {
    captured.topbar = props;
    // Expose the prototype trigger so tests can open the player like a user would.
    return React.createElement("button", {
      type: "button",
      "data-testid": "open-prototype",
      onClick: () => (props.onOpenPrototype as () => void)(),
    });
  },
}));
vi.mock("./assistant-panel", () => ({ FigmaAssistantPanel: () => null }));
vi.mock("@/figma/comments/comments-panel", () => ({ CommentsPanel: () => null }));
vi.mock("@/figma/prototype/prototype-player", () => ({
  PrototypePlayer: (props: Record<string, unknown>) => {
    captured.player = props;
    return React.createElement("div", { "data-testid": "prototype-player" });
  },
}));
vi.mock("@/figma/versions/versions-panel", () => ({ VersionsPanel: () => null }));

import { FigmaFileScreen } from "./file-screen";

let views: { unmount: () => void }[] = [];

beforeEach(() => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    value: true,
    configurable: true,
  });
  vi.stubGlobal("React", React);
  captured.toolbar = null;
  captured.inspect = null;
  captured.canvas = null;
  captured.player = null;
  captured.topbar = null;
  captured.layouts = [];
  routeParams.current = {};
  features.current = { figma: true, figmaNodeDepth: true };
  lastRerender = null;
  remote.statusData = null;
  remote.statusCalls = [];
  remote.execute.mockReset();
  remote.execute.mockResolvedValue({ result: { content: [] }, readbackAvailable: true });
  // Keep the merge-into-location behaviour; clear only the call history.
  const setParams = router.setParams as unknown as { mockClear: () => void };
  setParams.mockClear();
  figmaFns.invalidateFile.mockReset();
  figmaFns.invalidateQueries.mockReset();
  hooks.outline.mockImplementation(() => ({
    data: outlineFixture,
    isPending: false,
    isError: false,
    error: null,
  }));
  hooks.outline.mockClear();
  hooks.edits.mockClear();
  hooks.frameStore.mockClear();
  hooks.watch.mockClear();
  queueOverrides["1:1"] = { name: "Queued" };
  editsState.current = {
    linked: false,
    pendingCount: 1,
    overrides: queueOverrides,
    applyEdits: vi.fn(async () => undefined),
    applyPending: vi.fn(() => Promise.resolve()),
    discardPending: vi.fn(() => Promise.resolve()),
  };
});

afterEach(() => {
  for (const view of views) view.unmount();
  views = [];
});

function render(overrides: { version?: string } = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(
      <FigmaFileScreen
        serverId="s1"
        fileKey="file"
        {...(overrides.version ? { version: overrides.version } : {})}
      />,
    );
  });
  views.push({
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  });
  return container;
}

describe("FigmaFileScreen pending/version wiring", () => {
  it("hands the toolbar promise-returning pending callbacks, not voided calls", async () => {
    render();
    const toolbar = captured.toolbar as Record<string, () => unknown>;
    const applied = toolbar.onApplyPending();
    expect(applied).toBeInstanceOf(Promise);
    await applied;
    expect(editsState.current.applyPending).toHaveBeenCalledTimes(1);
    const discarded = toolbar.onDiscardPending();
    expect(discarded).toBeInstanceOf(Promise);
    await discarded;
    expect(editsState.current.discardPending).toHaveBeenCalledTimes(1);
  });

  it("keeps the live view editable and previews the current queue on the canvas", () => {
    render();
    expect((captured.toolbar as Record<string, unknown>).disabled).toBe(false);
    expect((captured.canvas as Record<string, unknown>).overrides).toBe(queueOverrides);
    expect((captured.inspect as Record<string, unknown>).disabled).toBe(false);
  });

  it("makes a historical version read-only and strips current pending overrides from it", () => {
    render({ version: "v3" });
    expect((captured.toolbar as Record<string, unknown>).disabled).toBe(true);
    expect((captured.inspect as Record<string, unknown>).disabled).toBe(true);
    const canvas = captured.canvas as Record<string, unknown>;
    expect(canvas.version).toBe("v3");
    expect(canvas.overrides).not.toBe(queueOverrides);
    expect(canvas.overrides).toEqual({});
    // A historical snapshot never watches the live file.
    expect(hooks.watch).toHaveBeenCalledWith(expect.objectContaining({ active: false }));
  });
});

describe("FigmaFileScreen capability gate (ADR-0039)", () => {
  it("gates the viewer once on figmaNodeDepth: update-host view, no new data path mounted", () => {
    features.current.figmaNodeDepth = false;
    const container = render();
    expect(container.querySelector('[data-testid="figma-update-host"]')).not.toBeNull();
    expect(container.textContent ?? "").toContain(
      "This host predates Section outlines — update the app running the daemon to open Figma files.",
    );
    // No fallback to the full Section: the inner screen (and every hook it holds) never mounts,
    // so this client never sends depth1 to a host that would silently strip the option.
    expect(hooks.outline).not.toHaveBeenCalled();
    expect(hooks.edits).not.toHaveBeenCalled();
    expect(hooks.frameStore).not.toHaveBeenCalled();
    expect(hooks.watch).not.toHaveBeenCalled();
    expect(captured.canvas).toBeNull();
    expect(captured.toolbar).toBeNull();
    expect(captured.inspect).toBeNull();
  });

  it("keeps the base figma gate first and unchanged for hosts that do not speak Figma at all", () => {
    features.current = { figma: false, figmaNodeDepth: false };
    const container = render();
    expect(container.textContent ?? "").toContain(
      "This host does not speak Figma yet — update the app running the daemon.",
    );
    // The depth view is only for hosts that speak Figma but predate the Section contract.
    expect(container.querySelector('[data-testid="figma-update-host"]')).toBeNull();
    expect(hooks.outline).not.toHaveBeenCalled();
    expect(captured.canvas).toBeNull();
  });

  it("mounts the full inner screen when both capabilities are present", () => {
    const container = render();
    expect(container.querySelector('[data-testid="figma-update-host"]')).toBeNull();
    expect(container.querySelector('[data-testid="figma-host-unsupported"]')).toBeNull();
    expect(captured.canvas).not.toBeNull();
    expect(captured.toolbar).not.toBeNull();
    expect(captured.inspect).not.toBeNull();
    expect(hooks.outline).toHaveBeenCalled();
    expect(hooks.watch).toHaveBeenCalledWith(expect.objectContaining({ active: true }));
  });
});

describe("FigmaFileScreen snapshot pinning and W6 prototype handoff", () => {
  function openPrototype(container: HTMLElement) {
    const trigger = container.querySelector('[data-testid="open-prototype"]') as HTMLButtonElement;
    act(() => trigger.click());
  }

  it("pins live asset paths to the outline snapshot version while keeping the viewer editable", () => {
    render();
    // ADR-0039: depth1 metadata, full subtrees and rasters must all carry the SAME explicit
    // snapshot — the outline's version — even for the live view.
    expect(hooks.frameStore).toHaveBeenCalledWith("s1", "file", "snap-1", expect.anything());
    expect((captured.canvas as Record<string, unknown>).version).toBe("snap-1");
    // Read-only-ness stays keyed to the explicit historical prop, not the derived snapshot.
    expect((captured.toolbar as Record<string, unknown>).disabled).toBe(false);
    expect((captured.inspect as Record<string, unknown>).disabled).toBe(false);
  });

  it("the explicit historical version wins over the outline snapshot for store and canvas", () => {
    render({ version: "v3" });
    expect(hooks.frameStore).toHaveBeenCalledWith("s1", "file", "v3", expect.anything());
    expect((captured.canvas as Record<string, unknown>).version).toBe("v3");
    expect((captured.toolbar as Record<string, unknown>).disabled).toBe(true);
    expect((captured.inspect as Record<string, unknown>).disabled).toBe(true);
  });

  it("hands the player the cached root FRAME, not the selected descendant", () => {
    routeParams.current = { node: "1-5" }; // dash form; ./node-url decodes to "1:5"
    const container = render();
    openPrototype(container);
    expect((captured.player as Record<string, unknown>).startNodeId).toBe("1:1");
  });

  it("honors the current page's flow when nothing is selected", () => {
    const container = render();
    openPrototype(container);
    expect((captured.player as Record<string, unknown>).startNodeId).toBe("9:9");
  });

  it("keeps a selected root frame; an uncached layer falls back to the flow, never its subtree", () => {
    // The mid-test `captured.player = null` keeps narrowing the property to null (a re-render
    // reassigns it inside a helper, which TS's control flow can't see), so read it through a
    // function: the call site resets narrowing to the declared type and the cast stays honest.
    const playerSeen = () => captured.player as Record<string, unknown>;
    routeParams.current = { node: "1-1" };
    const first = render();
    openPrototype(first);
    expect(playerSeen().startNodeId).toBe("1:1");

    captured.player = null;
    routeParams.current = { node: "7-7" }; // outside the cached chain
    const second = render();
    openPrototype(second);
    expect(playerSeen().startNodeId).toBe("9:9");
  });
});

// ── SECTION write path (spec 32.6.2 / acceptance 19 / ADR-0040) ─────────────────────────

import { SECTION_MOVE_DEADLINE_MS } from "./section-interaction";

interface ExecuteResponse {
  result: { content: unknown[]; isError?: boolean };
  readbackAvailable: boolean;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface CapturedCanvas {
  onMoveSection: (sectionId: string, dx: number, dy: number) => void;
  onSelectNode: (nodeId: string | null) => void;
  sectionEditing: { canEdit: boolean; notice: string | null };
  sectionOffsets: Record<string, { dx: number; dy: number }>;
  sectionMoveStatus: string | null;
  page: { id: string } | null;
  selectedNodeId: string | null;
  camera: { zoom: number; offsetX: number; offsetY: number };
}

function canvasProps(): CapturedCanvas {
  return captured.canvas as unknown as CapturedCanvas;
}

/** The page id actually handed to CanvasView — a null page yields null, so an expected id
 * fails the ASSERTION meaningfully (proving the canvas is page-less) instead of crashing or
 * type-erroring on a nullable access. */
function canvasPageId(): string | null {
  return canvasProps().page?.id ?? null;
}

let lastRerender: (() => void) | null = null;

/** Re-render the most recently mounted screen so swapped outline data takes effect. */
function settleRerender(): void {
  expect(lastRerender).not.toBeNull();
  act(() => lastRerender!());
}

/** Deliver the real layout pass the canvas size gate waits on (RN View mock captures it). */
function fireLayouts(width: number, height: number): void {
  act(() => {
    for (const onLayout of captured.layouts)
      onLayout({ nativeEvent: { layout: { width, height } } });
  });
}

/** The way a URL change reaches the screen: the location mutates, then it re-renders. */
function navigateRoute(params: Record<string, string | string[]>): void {
  routeParams.current = { ...routeParams.current, ...params };
  settleRerender();
}

/** Route writes that touched the `page` param — the page source-of-truth evidence. */
function pageRouteWrites(): Array<Record<string, string>> {
  const calls = (
    router.setParams as unknown as { mock: { calls: Array<[Record<string, string>]> } }
  ).mock.calls;
  return calls.map(([patch]) => patch).filter((patch) => "page" in patch);
}

function commitDrag(sectionId: string, dx: number, dy: number): void {
  act(() => canvasProps().onMoveSection(sectionId, dx, dy));
}

const settle = () => act(async () => undefined);

/** Replace the outline fixture so the SECTION's WORLD bounds read as (x, y) on the next fetch. */
function setSectionBounds(x: number, y: number): void {
  const page = outlineFixture.pages[0];
  const frames = page.frames.slice();
  const index = frames.findIndex((frame) => frame.id === "40:1");
  frames[index] = { ...frames[index], bounds: { ...frames[index].bounds, x, y } };
  hooks.outline.mockImplementation(() => ({
    data: { ...outlineFixture, pages: [{ ...page, frames }] },
    isPending: false,
    isError: false,
    error: null,
  }));
}

function mountEditable(overrides: { fileKey?: string; version?: string } = {}) {
  features.current.figmaRemoteWrites = true;
  remote.statusData = { state: "connected" };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const ref = {
    serverId: "s1",
    fileKey: overrides.fileKey ?? "file",
    ...(overrides.version ? { version: overrides.version } : {}),
  };
  act(() => root.render(<FigmaFileScreen {...ref} />));
  views.push({
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  });
  const rerender = (next: Partial<{ fileKey: string; version: string }> = {}) => {
    act(() => root.render(<FigmaFileScreen {...ref} {...next} />));
  };
  lastRerender = rerender;
  return { rerender, container };
}

describe("FigmaFileScreen SECTION write path", () => {
  it("commits ONE write whose script guards what metadata cannot attest", async () => {
    mountEditable();
    commitDrag("40:1", 100, 50); // world target: bounds 10,20 + 100,50 = 110,70
    expect(remote.execute).toHaveBeenCalledTimes(1);
    const params = remote.execute.mock.calls[0][0];
    expect(params.fileKey).toBe("file");
    // Never figma.currentPage.findOne: existence asserts (throw, never silent), the ACTUAL
    // ancestor page is set, and type/locks are re-checked AFTER the await before any write.
    expect(params.code).toContain('const sectionId = "40:1";');
    expect(params.code.match(/getNodeByIdAsync/g)).toHaveLength(2); // initial resolve + post-switch re-read
    expect(params.code).toContain("does not exist");
    expect(params.code).toContain("not a SECTION");
    expect(params.code).toContain("locked at write time");
    expect(params.code.indexOf("locked at write time")).toBeGreaterThan(
      params.code.indexOf("await figma.setCurrentPageAsync(page)"),
    );
    expect(params.code).toContain("/ det");
    expect(params.code).toContain("const gx = 110 - m[0][2]");
    expect(params.code).toContain("gy = 70 - m[1][2]");
    expect(params.code).toContain("before");
    expect(params.code).toContain("after");
    expect(params.code).not.toContain("figma.currentPage");
    expect(params.description).toContain('Move SECTION "Flow Board" to (110, 70)');
    // The preview stands while the write is in flight.
    expect(canvasProps().sectionMoveStatus).toBe("saving");
    expect(canvasProps().sectionOffsets).toEqual({ "40:1": { dx: 100, dy: 50 } });
  });

  it("without the write capability the status hook stays disabled and a drag writes nothing", () => {
    remote.statusData = { state: "connected" };
    render();
    expect(remote.statusCalls[remote.statusCalls.length - 1]).toEqual({ enabled: false });
    commitDrag("40:1", 40, 0);
    expect(remote.execute).not.toHaveBeenCalled();
    expect(canvasProps().sectionEditing.canEdit).toBe(false);
    expect(canvasProps().sectionEditing.notice).toBe("Connect editing");
  });

  it("capability but no connected connector is select/pan only — never a silent write", () => {
    features.current.figmaRemoteWrites = true;
    remote.statusData = { state: "disconnected" };
    render();
    commitDrag("40:1", 30, 30);
    expect(remote.execute).not.toHaveBeenCalled();
    expect(canvasProps().sectionEditing.canEdit).toBe(false);
  });

  it("a historical version stays read-only even with capability and a connected connector", () => {
    features.current.figmaRemoteWrites = true;
    remote.statusData = { state: "connected" };
    render({ version: "v9" });
    commitDrag("40:1", 30, 30);
    expect(remote.execute).not.toHaveBeenCalled();
    expect(canvasProps().sectionEditing.notice).toBe("Connect editing");
  });

  it("a synchronous in-flight latch drops fast second drags until the write settles", async () => {
    mountEditable();
    const pending = deferred<ExecuteResponse>();
    remote.execute.mockReturnValue(pending.promise);
    commitDrag("40:1", 100, 50);
    commitDrag("40:1", -40, 0); // too fast: the first reply has not landed
    expect(remote.execute).toHaveBeenCalledTimes(1);
    pending.resolve({ result: { content: [] }, readbackAvailable: true });
    await settle();
    // Still in flight while the INDEPENDENT readback decides — the reply alone is not a settle.
    commitDrag("40:1", -40, 0);
    expect(remote.execute).toHaveBeenCalledTimes(1);
  });

  it("only matching independently refreshed metadata settles the move, not the reply", async () => {
    mountEditable();
    commitDrag("40:1", 100, 50);
    await settle(); // the default success reply lands: invalidate, status still saving
    expect(figmaFns.invalidateFile).toHaveBeenCalledTimes(1);
    expect(canvasProps().sectionMoveStatus).toBe("saving");
    setSectionBounds(110, 70); // the re-read agrees with the committed WORLD target
    // (nested-parent offsets are the script's inverse-transform concern, not the verifier's)
    settleRerender();
    expect(canvasProps().sectionMoveStatus).toBeNull();
    expect(canvasProps().sectionOffsets).toEqual({});
  });

  it("a mismatching refresh settles to unverified and drops the preview", async () => {
    mountEditable();
    commitDrag("40:1", 100, 50);
    await settle();
    setSectionBounds(110, 999); // metadata says otherwise (new version or lost write)
    settleRerender();
    expect(canvasProps().sectionMoveStatus).toBe("unverified");
    expect(canvasProps().sectionOffsets).toEqual({});
  });

  it("an error reply rolls back: failed, preview gone, no invalidate/refetch", async () => {
    remote.execute.mockResolvedValue({
      result: { content: [], isError: true },
      readbackAvailable: true,
    });
    mountEditable();
    commitDrag("40:1", 100, 50);
    await settle();
    expect(canvasProps().sectionMoveStatus).toBe("failed");
    expect(canvasProps().sectionOffsets).toEqual({});
    expect(figmaFns.invalidateFile).not.toHaveBeenCalled();
  });

  it("a rejected reply rolls back the same way", async () => {
    remote.execute.mockRejectedValue(new Error("socket died"));
    mountEditable();
    commitDrag("40:1", 100, 50);
    await settle();
    expect(canvasProps().sectionMoveStatus).toBe("failed");
    expect(canvasProps().sectionOffsets).toEqual({});
  });

  it("a failed daemon re-read settles unverified and DROPS the preview while refresh proceeds", async () => {
    remote.execute.mockResolvedValue({ result: { content: [] }, readbackAvailable: false });
    mountEditable();
    commitDrag("40:1", 100, 50);
    await settle();
    expect(canvasProps().sectionMoveStatus).toBe("unverified"); // uncertainty stays visibly flagged
    expect(canvasProps().sectionOffsets).toEqual({}); // a preview that outlives proof silently lies
  });

  it("never saving forever: the deadline settles a silent readback, with no auto retry", async () => {
    vi.useFakeTimers();
    try {
      mountEditable();
      commitDrag("40:1", 100, 50);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SECTION_MOVE_DEADLINE_MS);
      });
      expect(canvasProps().sectionMoveStatus).toBe("unverified");
      // No automatic retry: a late matching refresh must NOT flip the verdict back to saved.
      setSectionBounds(110, 70);
      settleRerender();
      expect(canvasProps().sectionMoveStatus).toBe("unverified");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a file switch mid-write drops the preview and a late reply fetches nothing stale", async () => {
    const screen = mountEditable();
    const pending = deferred<ExecuteResponse>();
    remote.execute.mockReturnValue(pending.promise);
    commitDrag("40:1", 100, 50);
    screen.rerender({ fileKey: "other" });
    expect(canvasProps().sectionMoveStatus).toBeNull();
    expect(canvasProps().sectionOffsets).toEqual({});
    pending.resolve({ result: { content: [] }, readbackAvailable: true });
    await settle();
    expect(figmaFns.invalidateFile).not.toHaveBeenCalled(); // no stale invalidate/refetch
    commitDrag("40:1", 10, 10); // the latch is free again for the new file
    expect(remote.execute).toHaveBeenCalledTimes(2);
  });

  it("a page switch mid-write is identity-stale: the late reply settles nothing and refetches nothing", async () => {
    mountEditable();
    const pending = deferred<ExecuteResponse>();
    remote.execute.mockReturnValue(pending.promise);
    commitDrag("40:1", 100, 50);
    // The top bar page change now flows through the URL — the same route the sidebar writes —
    // and the screen reacts when the location echo lands (realistic, not a local shortcut).
    act(() => (captured.topbar as { onSelectPage: (id: string) => void }).onSelectPage("p2"));
    settleRerender();
    expect(canvasProps().sectionMoveStatus).toBeNull();
    expect(canvasProps().sectionOffsets).toEqual({});
    pending.resolve({ result: { content: [] }, readbackAvailable: true });
    await settle();
    expect(figmaFns.invalidateFile).not.toHaveBeenCalled();
    // The refreshed outline now reports the section where p1's committed target was — but the
    // write belonged to a page that is no longer visible: no delayed "verified" flip either.
    setSectionBounds(110, 70);
    settleRerender();
    expect(canvasProps().sectionMoveStatus).toBeNull();
  });

  it("a version switch mid-write remounts fresh, swallows the late reply, and stays read-only", async () => {
    const screen = mountEditable();
    const pending = deferred<ExecuteResponse>();
    remote.execute.mockReturnValue(pending.promise);
    commitDrag("40:1", 100, 50);
    screen.rerender({ version: "v9" }); // keyed identity change: the inner mount is brand new
    expect(canvasProps().sectionMoveStatus).toBeNull();
    expect(canvasProps().sectionOffsets).toEqual({});
    expect(canvasProps().sectionEditing.canEdit).toBe(false); // historical: select/pan only
    pending.resolve({ result: { content: [] }, readbackAvailable: true });
    await settle();
    expect(figmaFns.invalidateFile).not.toHaveBeenCalled(); // no stale invalidate/refetch
    commitDrag("40:1", 10, 10); // read-only surfaces never write
    expect(remote.execute).toHaveBeenCalledTimes(1);
  });

  it("a non-finite committed delta never reaches the RPC", () => {
    mountEditable();
    commitDrag("40:1", Number.NaN, 5);
    commitDrag("40:1", 5, Number.POSITIVE_INFINITY);
    expect(remote.execute).not.toHaveBeenCalled();
    expect(canvasProps().sectionMoveStatus).toBeNull();
  });
});

// ── page route sync (spec 32.5.1): the URL is the single source of truth ──────────────────
// Sidebar (useFigmaNav go), top bar (router.setParams) and the canvas all converge on the
// route's `page`/`node` params. These tests drive the screen the way expo-router does: the
// location mutates, then the screen re-renders — no fake local page state shortcuts.

describe("FigmaFileScreen page route sync", () => {
  it("a sidebar URL page change flips the page the CanvasView actually renders", () => {
    mountEditable();
    expect(canvasPageId()).toBe("p1");
    // sidebarPageRow: go({ pageId: "p2", nodeId: null }) writes page and clears node.
    navigateRoute({ page: "p2", node: "" });
    expect(canvasPageId()).toBe("p2");
    expect(canvasProps().selectedNodeId).toBeNull();
  });

  it("top-bar page selection writes route page AND node clear in ONE param write", () => {
    mountEditable();
    fireLayouts(800, 600);
    act(() => canvasProps().onSelectNode("1:1")); // canvas click: selection into the URL
    settleRerender();
    expect(routeParams.current.node).toBe("1-1");
    expect(canvasProps().selectedNodeId).toBe("1:1");
    act(() => (captured.topbar as { onSelectPage: (id: string) => void }).onSelectPage("p2"));
    const writes = pageRouteWrites();
    // The only writes touching `page`: the mount canonicalization of the default, then the
    // top-bar selection — which lands page AND node clear in ONE call, never two half-writes.
    expect(writes).toEqual([{ page: "p1" }, { page: "p2", node: "" }]);
    settleRerender();
    expect(canvasPageId()).toBe("p2");
    expect(canvasProps().selectedNodeId).toBeNull(); // stale p1 selection follows the route
  });

  it("back/forward history restore of page+node shows that page and focuses that node", () => {
    mountEditable();
    fireLayouts(800, 600);
    act(() => canvasProps().onSelectNode("1:1"));
    settleRerender();
    expect(canvasProps().selectedNodeId).toBe("1:1");
    // Canvas-originated selection never moved the camera; only a URL-driven focus may.
    const cameraBefore = canvasProps().camera;
    expect(cameraBefore).toEqual({ zoom: 1, offsetX: 0, offsetY: 0 });
    // History lands on the earlier p2 deep link: the URL names page p2, node 60:1.
    navigateRoute({ page: "p2", node: "60-1" });
    expect(canvasPageId()).toBe("p2");
    expect(canvasProps().selectedNodeId).toBe("60:1"); // restored THROUGH the route, not local state
    expect(canvasProps().camera).not.toEqual(cameraBefore); // the URL focus effect drove the camera
  });

  it("a route without a page shows the first real outline page and canonicalizes it ONCE", () => {
    mountEditable();
    expect(canvasPageId()).toBe("p1"); // the first REAL page, never an invented one
    expect(pageRouteWrites()).toEqual([{ page: "p1" }]);
    // The mock setParams already echoed into the location; further renders must not re-write
    // (a guard keyed on the outline snapshot, not a per-render router.go loop).
    settleRerender();
    settleRerender();
    expect(pageRouteWrites()).toHaveLength(1);
  });

  it("an unknown route page errors clearly: no silent fallback page, no wrong-node focus", () => {
    routeParams.current = { page: "p9", node: "40-1" };
    const { container } = mountEditable();
    fireLayouts(800, 600);
    expect(canvasProps().page).toBeNull(); // never silently show a DIFFERENT page
    expect(container.textContent).toContain("Page p9 is not in this file.");
    // No camera policy invented for a page that isn't there: nothing was focused or zoomed.
    expect(canvasProps().camera).toEqual({ zoom: 1, offsetX: 0, offsetY: 0 });
  });

  it("a return to a page-less URL re-canonicalizes: a REAL page param forgets the stale stamp", () => {
    mountEditable();
    expect(pageRouteWrites()).toEqual([{ page: "p1" }]); // the mount canonicalization
    navigateRoute({ page: "p2" }); // a real page param arrives: the stamp is forgotten
    routeParams.current = {}; // browser back/forward lands on the OLD page-less URL
    settleRerender();
    expect(pageRouteWrites()).toEqual([{ page: "p1" }, { page: "p1" }]); // canonicalized AGAIN
    settleRerender();
    settleRerender(); // the echo lands; extra renders must not re-write — no param loop
    expect(pageRouteWrites()).toHaveLength(2);
  });

  it("correcting an unknown page clears ONLY the route banner; unrelated focus errors survive", async () => {
    routeParams.current = { page: "p9" };
    const { container } = mountEditable();
    fireLayouts(800, 600);
    expect(container.textContent).toContain("Page p9 is not in this file.");
    navigateRoute({ page: "p2" }); // route becomes valid: the banner this effect raised clears
    expect(container.textContent ?? "").not.toContain("is not in this file.");
    expect(canvasPageId()).toBe("p2");

    // An unrelated layer-focus error (deep link to a nonexistent layer) through the REAL
    // URL-focus path — no local shortcut.
    routeParams.current = { page: "p2", node: "88-8" };
    settleRerender();
    await settle();
    expect(container.textContent).toContain("Layer 88:8 was not found in this page.");

    // Re-run the route effect while the UNRELATED error is current (outline identity swap,
    // the same mechanism the readback refresh uses): the valid-route clear must compare
    // signatures and leave the focus error alone, never setFocusError(null) blindly.
    hooks.outline.mockImplementation(() => ({
      data: { ...outlineFixture },
      isPending: false,
      isError: false,
      error: null,
    }));
    settleRerender();
    expect(container.textContent).toContain("Layer 88:8 was not found in this page.");
    // And the correction looped nothing: no extra page-param writes anywhere in this flow.
    expect(pageRouteWrites()).toEqual([]);
  });

  it("selecting a node through the URL never re-keys the frame store (no asset remount)", () => {
    mountEditable();
    fireLayouts(800, 600);
    const keyBefore = hooks.frameStore.mock.calls.at(-1);
    navigateRoute({ node: "1-5" });
    navigateRoute({ node: "1-1" });
    expect(hooks.frameStore.mock.calls.at(-1)).toEqual(keyBefore); // same identity args: same mount
  });

  it("the canvas echo of its own selection never re-centres the camera (#185)", () => {
    mountEditable();
    fireLayouts(800, 600);
    act(() => canvasProps().onSelectNode("1:1"));
    settleRerender(); // the echoed node param arrives here
    const camera = canvasProps().camera;
    const writes = (router.setParams as unknown as { mock: { calls: unknown[] } }).mock.calls
      .length;
    settleRerender();
    settleRerender();
    expect(canvasProps().camera).toEqual(camera); // stable: echo skipped, not re-focused
    // No second write: the echo never re-triggered selectNode/focusNode in a loop.
    expect((router.setParams as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(
      writes,
    );
  });
});
