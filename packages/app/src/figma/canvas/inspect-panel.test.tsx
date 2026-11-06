/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FigmaComponentMeta,
  FigmaNode,
  FigmaPendingOp,
} from "@jagentdesk/protocol/figma/rpc-schemas";
import { makeNode, makePendingOp } from "./__fixtures__/figma";

const { fetchFigmaExportMock } = vi.hoisted(() => ({
  fetchFigmaExportMock: vi.fn(async () => ({ file: null, fileName: null })),
}));
// The InspectPanel reads the local queue through the same hook the PendingBar uses;
// tests reassign this to seed queued ops (read lazily by the mock below).
let pendingQueueOps: FigmaPendingOp[] = [];

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 1.5: 6, 2: 8, 3: 12, 4: 16, 6: 24 },
    fontSize: { xs: 11, sm: 13, base: 15, lg: 17 },
    fontWeight: { normal: "400", medium: "500", semibold: "600" },
    borderRadius: { sm: 4, md: 6, lg: 8, full: 9999 },
    borderWidth: { 1: 1 },
    fontFamily: { mono: "monospace" },
    colors: {
      surface0: "#0a0a0a",
      surface1: "#111",
      surface3: "#222",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      foregroundExtraMuted: "#777",
      border: "#555",
      accent: "#0a84ff",
      statusSuccess: "#00ff00",
      statusWarning: "#ff9500",
      statusDanger: "#ff0000",
      palette: { red: { 300: "#ff6b6b" }, green: { 400: "#4ade80" }, white: "#fff" },
    },
  },
}));

vi.mock("react-native", () => ({
  Platform: { OS: "web" },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("div", { "data-testid": testID }, children),
  Text: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("span", { "data-testid": testID }, children),
  TextInput: (props: Record<string, unknown>) =>
    React.createElement("input", {
      readOnly: true,
      value: String(props.value ?? ""),
      placeholder: String(props.placeholder ?? ""),
    }),
  ScrollView: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("div", { "data-testid": testID }, children),
  Pressable: ({
    children,
    onPress,
    testID,
  }: {
    children?: React.ReactNode;
    onPress?: () => void;
    testID?: string;
  }) =>
    React.createElement(
      "div",
      { role: "button", "data-testid": testID, onClick: onPress },
      children,
    ),
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

vi.mock("@/jira/ui/styles", () => {
  const style = new Proxy({}, { get: () => ({}) });
  return { jiraStyles: style };
});

vi.mock("@/jira/ui/primitives", () => ({
  Input: (props: {
    value?: string;
    placeholder?: string;
    accessibilityLabel?: string;
    onChangeText?: (text: string) => void;
    onSubmitEditing?: () => void;
  }) =>
    React.createElement(
      "div",
      null,
      React.createElement("input", {
        "data-testid": `input:${props.accessibilityLabel ?? props.placeholder ?? ""}`,
        value: props.value ?? "",
        placeholder: props.placeholder ?? "",
        readOnly: true,
        ref: (node: HTMLInputElement | null) => {
          // Tests set text through this hook: jsdom cannot type into a controlled input.
          if (node)
            (node as HTMLInputElement & { setText?: (text: string) => void }).setText =
              props.onChangeText;
        },
        onChange: (event: { target: HTMLInputElement }) => props.onChangeText?.(event.target.value),
      }),
      // A real keyboard "enter" commits the field; jsdom cannot focus-type, so expose the
      // commit handler as a button the tests can click.
      React.createElement("button", {
        type: "button",
        "data-testid": `commit:${props.accessibilityLabel ?? props.placeholder ?? ""}`,
        onClick: () => props.onSubmitEditing?.(),
      }),
    ),
  ErrorBanner: ({ message, action }: { message: string; action?: React.ReactNode }) =>
    React.createElement("span", { "data-testid": "error-banner" }, message, action ?? null),
}));

// Honour `disabled` like the real Button: the historical-snapshot tests assert write controls
// are disabled AND that the guarded callback swallows a dispatched press.
vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    disabled,
  }: {
    children?: React.ReactNode;
    onPress?: () => void;
    disabled?: boolean;
  }) =>
    React.createElement(
      "button",
      { type: "button", disabled: Boolean(disabled), onClick: onPress },
      children,
    ),
}));

vi.mock("lucide-react-native", () => {
  const icon = (name: string) => () => React.createElement("span", { "data-icon": name });
  return {
    Check: icon("Check"),
    ChevronDown: icon("ChevronDown"),
    ChevronRight: icon("ChevronRight"),
    CircleAlert: icon("CircleAlert"),
    Copy: icon("Copy"),
    Download: icon("Download"),
    Eye: icon("Eye"),
    EyeOff: icon("EyeOff"),
    Lock: icon("Lock"),
    Loader2: icon("Loader2"),
    Unlock: icon("Unlock"),
  };
});

vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => undefined) }));

// ./api pulls in the host runtime (expo-constants chain) just for errorMessage's home; mock it
// so the jsdom test never loads the native app-version module.
vi.mock("@/runtime/host-runtime", () => ({ useHostRuntimeClient: () => null }));

vi.mock("./use-figma-file", () => ({
  fetchFigmaExport: fetchFigmaExportMock,
  useFigmaPendingOps: () => pendingQueueOps,
}));

vi.mock("./save-bytes", () => ({ saveExportedBytes: vi.fn(async () => undefined) }));

import { InspectPanel } from "./inspect-panel";
import { PANEL_LABEL_WIDTH } from "./panel-ui";

function renderPanel(
  node: FigmaNode | null,
  componentMeta?: (id: string) => FigmaComponentMeta | undefined,
  opts?: {
    parentOf?: (id: string) => FigmaNode | null | undefined;
    applyEdits?: (ops: unknown[], fields?: string[]) => Promise<void>;
    linked?: boolean;
    queue?: FigmaPendingOp[];
    disabled?: boolean;
  },
) {
  pendingQueueOps = opts?.queue ?? [];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(
      <InspectPanel
        serverId="s1"
        fileKey="file"
        node={node}
        linked={opts?.linked ?? false}
        applyEdits={opts?.applyEdits ?? vi.fn(async () => undefined)}
        disabled={opts?.disabled}
        componentMeta={componentMeta}
        parentOf={opts?.parentOf}
      />,
    );
  });
  return { container, root };
}

describe("InspectPanel fill section", () => {
  let roots: Root[] = [];
  let containers: HTMLDivElement[] = [];

  beforeEach(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      value: true,
      configurable: true,
    });
    vi.stubGlobal("React", React);
    roots = [];
    containers = [];
  });

  afterEach(() => {
    for (const root of roots) act(() => root.unmount());
    for (const container of containers) container.remove();
    roots = [];
    containers = [];
  });

  function render(
    node: FigmaNode | null,
    componentMeta?: (id: string) => FigmaComponentMeta | undefined,
    opts?: {
      parentOf?: (id: string) => FigmaNode | null | undefined;
      applyEdits?: (ops: unknown[], fields?: string[]) => Promise<void>;
      linked?: boolean;
      queue?: FigmaPendingOp[];
    },
  ) {
    const view = renderPanel(node, componentMeta, opts);
    roots.push(view.root);
    containers.push(view.container);
    return view;
  }

  function linearNode(): FigmaNode {
    return makeNode({
      fills: [
        {
          type: "GRADIENT_LINEAR",
          visible: true,
          gradientHandlePositions: [
            { x: 0, y: 0.5 },
            { x: 1, y: 0.5 },
            { x: 0, y: 0 },
          ],
          gradientStops: [
            { position: 0, color: { r: 0.494, g: 0.827, b: 0.129, a: 1 } },
            { position: 1, color: { r: 0, g: 0.56, b: 0.22, a: 1 } },
          ],
        },
      ],
    });
  }

  it("shows a gradient swatch, the gradient type and stops instead of the hex input", () => {
    const { container } = render(linearNode());
    const text = container.textContent ?? "";
    expect(text).toContain("Linear gradient");
    expect(text).toContain("rgba(126, 211, 33, 1) 0%");
    expect(text).toContain("rgba(0, 143, 56, 1) 100%");
    expect(container.querySelector('input[placeholder="#RRGGBB"]')).toBeNull();
    expect(container.querySelector('[data-testid="figma-inspect-gradient-fill"]')).not.toBeNull();
  });

  it("keeps the hex input for solid fills", () => {
    const { container } = render(
      makeNode({ fills: [{ type: "SOLID", visible: true, color: { r: 1, g: 1, b: 1, a: 1 } }] }),
    );
    expect(container.querySelector('input[placeholder="#RRGGBB"]')).not.toBeNull();
    expect(container.textContent ?? "").not.toContain("Linear gradient");
  });

  it("shows top/right/bottom/left padding fields and the collapsed CSS shorthand", () => {
    const { container } = render(
      makeNode({
        layoutMode: "HORIZONTAL",
        paddingTop: 12,
        paddingRight: 24,
        paddingBottom: 12,
        paddingLeft: 24,
      }),
    );
    const byLabel = (label: string) =>
      container.querySelector(`input[data-testid="input:${label}"]`) as HTMLInputElement | null;
    expect(byLabel("Top")?.value).toBe("12");
    expect(byLabel("Right")?.value).toBe("24");
    expect(byLabel("Bottom")?.value).toBe("12");
    expect(byLabel("Left")?.value).toBe("24");
    expect(container.textContent ?? "").toContain("padding: 12px 24px;");
  });

  it("labels a local component by name, not the id, and never as a team library", () => {
    const meta: FigmaComponentMeta = { key: "k1", name: "Button", remote: false };
    const { container } = render(makeNode({ componentId: "5:2" }), () => meta);
    const text = container.textContent ?? "";
    expect(text).toContain("Button");
    expect(text).toContain("Local component");
    expect(text).not.toContain("Team library");
  });

  it("falls back to Local component when remote is absent and Team library only when remote", () => {
    const absent = render(makeNode({ componentId: "5:2" }), () => ({ key: "k1", name: "Chip" }));
    expect(absent.container.textContent ?? "").toContain("Local component");

    const remote = render(makeNode({ componentId: "9:9" }), () => ({
      key: "k2",
      name: "Team Button",
      remote: true,
    }));
    const text = remote.container.textContent ?? "";
    expect(text).toContain("Team Button");
    expect(text).toContain("Team library");
    expect(text).not.toContain("Local component");
  });

  it("shows the component id without inventing a library when no metadata has loaded yet", () => {
    const { container } = render(makeNode({ componentId: "5:2" }), () => undefined);
    const text = container.textContent ?? "";
    expect(text).toContain("5:2");
    expect(text).not.toContain("Local component");
    expect(text).not.toContain("Team library");
  });

  it("renders one row per gradient stop with the full colour and position", () => {
    const { container } = render(linearNode());
    const rows = container.querySelectorAll('[data-testid="figma-inspect-gradient-stop"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent ?? "").toContain("rgba(126, 211, 33, 1)");
    expect(rows[0].textContent ?? "").toContain("0%");
    expect(rows[1].textContent ?? "").toContain("rgba(0, 143, 56, 1)");
    expect(rows[1].textContent ?? "").toContain("100%");
  });

  it("shows the font of a REST-shape text node, not an em dash", () => {
    const { container } = render(
      makeNode({
        type: "TEXT",
        characters: "Welcome back",
        style: { fontFamily: "Inter", fontStyle: "Bold", fontSize: 34 },
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Inter Bold");
    expect(text).not.toContain("Font —");
    expect(text).toContain('font-family: "Inter";');
    expect(text).toContain("font-weight: 700;");
  });

  it("shows X/Y relative to the containing frame", () => {
    const frame = makeNode({
      id: "1:60",
      absoluteBoundingBox: { x: 910, y: 400, width: 430, height: 900 },
    });
    const child = makeNode({
      id: "1:61",
      absoluteBoundingBox: { x: 934, y: 424, width: 327, height: 52 },
    });
    const { container } = render(child, undefined, {
      parentOf: (id) => (id === "1:61" ? frame : undefined),
    });
    const value = (label: string) =>
      (container.querySelector(`input[data-testid="input:${label}"]`) as HTMLInputElement)?.value;
    expect(value("X")).toBe("24");
    expect(value("Y")).toBe("24");
    expect(value("W")).toBe("327");
    expect(value("H")).toBe("52");
  });

  it("keeps page-absolute X/Y for top-level frames", () => {
    const frame = makeNode({
      id: "1:60",
      absoluteBoundingBox: { x: 910, y: 400, width: 430, height: 900 },
    });
    const { container } = render(frame, undefined, { parentOf: () => null });
    const value = (label: string) =>
      (container.querySelector(`input[data-testid="input:${label}"]`) as HTMLInputElement)?.value;
    expect(value("X")).toBe("910");
    expect(value("Y")).toBe("400");
  });

  it("converts an X edit back to page-absolute before building the op", () => {
    const frame = makeNode({
      id: "1:60",
      absoluteBoundingBox: { x: 910, y: 400, width: 430, height: 900 },
    });
    const child = makeNode({
      id: "1:61",
      absoluteBoundingBox: { x: 934, y: 424, width: 327, height: 52 },
    });
    const applyEdits = vi.fn(async (_ops: unknown[]) => undefined);
    const { container } = render(child, undefined, {
      parentOf: (id) => (id === "1:61" ? frame : undefined),
      applyEdits,
    });
    const input = container.querySelector('input[data-testid="input:X"]') as HTMLInputElement & {
      setText?: (text: string) => void;
    };
    expect(input.value).toBe("24");
    act(() => {
      input.setText?.("40");
    });
    act(() => {
      (container.querySelector('button[data-testid="commit:X"]') as HTMLButtonElement).click();
    });
    expect(applyEdits).toHaveBeenCalledTimes(1);
    expect(applyEdits).toHaveBeenCalledWith([
      expect.objectContaining({ op: "set_geometry", nodeId: "1:61", x: 950 }),
    ]);
  });

  it("sizes the panel label column so labels never truncate", () => {
    // "Letter spacing" is the widest inspect label; at 13px it needs ~95px plus the rail gap.
    expect(PANEL_LABEL_WIDTH).toBeGreaterThanOrEqual(108);
    const { container } = render(makeNode({ type: "TEXT", characters: "x" }));
    expect(container.textContent ?? "").toContain("Letter spacing");
  });
});

describe("InspectPanel honest edit states", () => {
  let roots: Root[] = [];
  let containers: HTMLDivElement[] = [];

  beforeEach(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      value: true,
      configurable: true,
    });
    vi.stubGlobal("React", React);
    roots = [];
    containers = [];
  });

  afterEach(() => {
    for (const root of roots) act(() => root.unmount());
    for (const container of containers) container.remove();
    roots = [];
    containers = [];
    pendingQueueOps = [];
    fetchFigmaExportMock.mockReset();
    fetchFigmaExportMock.mockImplementation(async () => ({ file: null, fileName: null }));
  });

  function render(
    node: FigmaNode | null,
    opts: {
      applyEdits?: (ops: unknown[]) => Promise<void>;
      queue?: FigmaPendingOp[];
    } = {},
  ) {
    const view = renderPanel(node, undefined, opts);
    roots.push(view.root);
    containers.push(view.container);
    return view;
  }

  function field(container: HTMLElement, label: string): HTMLInputElement | null {
    return container.querySelector(`input[data-testid="input:${label}"]`);
  }

  it("previews the queued text value with a Pending badge and never claims it is saved", () => {
    const { container } = render(makeNode({ id: "1:1", type: "TEXT", characters: "Original" }), {
      queue: [makePendingOp({ op: "set_text", nodeId: "1:1", characters: "Queued label" })],
    });
    const inputs = [...container.querySelectorAll<HTMLInputElement>('input[data-testid="input:"]')];
    expect(inputs.some((input) => input.value === "Queued label")).toBe(true);
    expect(container.querySelector('[data-testid="figma-edit-pending"]')).not.toBeNull();
    const text = container.textContent ?? "";
    expect(text).toContain("1 pending change here — not saved in Figma yet.");
    expect(text).not.toContain("Saved");
  });

  it("previews queued geometry in the W field and keeps untouched fields at the raw value", () => {
    const { container } = render(
      makeNode({ id: "1:1", absoluteBoundingBox: { x: 0, y: 0, width: 327, height: 52 } }),
      { queue: [makePendingOp({ op: "set_geometry", nodeId: "1:1", width: 640 })] },
    );
    expect(field(container, "W")?.value).toBe("640");
    expect(field(container, "H")?.value).toBe("52");
    expect(container.querySelector('[data-testid="figma-edit-pending"]')).not.toBeNull();
  });

  it("shows no pending UI for a queue entry on another node or a non-pending state", () => {
    const others = render(makeNode({ id: "1:1", name: "Card" }), {
      queue: [makePendingOp({ op: "rename", nodeId: "9:9", name: "Elsewhere" })],
    });
    expect(others.container.textContent ?? "").not.toContain("pending change");
    expect(others.container.querySelector('[data-testid="figma-edit-pending"]')).toBeNull();

    const applied = render(makeNode({ id: "1:1", name: "Card" }), {
      queue: [makePendingOp({ op: "rename", nodeId: "1:1", name: "Done" }, { state: "applied" })],
    });
    expect(applied.container.textContent ?? "").not.toContain("pending change");
    expect(field(applied.container, "Top")).toBeNull(); // sanity: unrelated fields unaffected
  });

  it("keeps a rejected edit visible with the real message until dismissed", async () => {
    const applyEdits = vi.fn(async () => {
      throw new Error("Unsupported edit op: set_fill");
    });
    const { container } = render(
      makeNode({
        id: "1:1",
        fills: [{ type: "SOLID", visible: true, color: { r: 1, g: 1, b: 1, a: 1 } }],
      }),
      { applyEdits },
    );
    const input = container.querySelector('input[data-testid="input:#RRGGBB"]') as
      | (HTMLInputElement & { setText?: (text: string) => void })
      | null;
    expect(input).not.toBeNull();
    act(() => {
      input?.setText?.("#ff8000");
    });
    await act(async () => {
      (
        container.querySelector('button[data-testid="commit:#RRGGBB"]') as HTMLButtonElement
      ).click();
    });
    const banner = container.querySelector('[data-testid="error-banner"]');
    expect(banner?.textContent ?? "").toContain("Unsupported edit op: set_fill");
    expect(banner?.textContent ?? "").not.toContain("check the queue");

    await act(async () => {
      (container.querySelector('[data-testid="figma-edit-error-dismiss"]') as HTMLElement).click();
    });
    expect(container.querySelector('[data-testid="error-banner"]')).toBeNull();
  });

  it("clears the failure banner when a retry succeeds", async () => {
    let reject = true;
    const applyEdits = vi.fn(async (_ops: unknown[]) => {
      if (reject) throw new Error("Figma Link disconnected");
    });
    const { container } = render(makeNode({ id: "1:1" }), { applyEdits });
    const nameInput = container.querySelector('input[data-testid="input:"]') as
      | (HTMLInputElement & { setText?: (text: string) => void })
      | null;
    act(() => {
      nameInput?.setText?.("Renamed");
    });
    await act(async () => {
      (container.querySelector('button[data-testid="commit:"]') as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-testid="error-banner"]')?.textContent ?? "").toContain(
      "Figma Link disconnected",
    );

    reject = false;
    const widthInput = field(container, "W") as
      | (HTMLInputElement & { setText?: (text: string) => void })
      | null;
    // The failing edit left no queue entry, so a fresh edit must be able to succeed and clear.
    act(() => {
      widthInput?.setText?.("512");
    });
    await act(async () => {
      (container.querySelector('button[data-testid="commit:W"]') as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-testid="error-banner"]')).toBeNull();
  });

  it("surfaces the real export error instead of blaming the queue", async () => {
    fetchFigmaExportMock.mockRejectedValueOnce(new Error("Figma export failed (502)"));
    const { container } = render(makeNode({ id: "1:1", name: "Card" }));
    const exportButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Export",
    ) as HTMLButtonElement | undefined;
    expect(exportButton).toBeDefined();
    await act(async () => {
      exportButton?.click();
    });
    const text = container.textContent ?? "";
    expect(text).toContain("Figma export failed (502)");
    expect(text).not.toContain("check the queue");
  });

  it("runs export against the raw node even while an edit is queued", async () => {
    const { container } = render(makeNode({ id: "1:1", name: "Card" }), {
      queue: [makePendingOp({ op: "rename", nodeId: "1:1", name: "Queued" })],
    });
    const exportButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Export",
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      exportButton?.click();
    });
    expect(fetchFigmaExportMock).toHaveBeenCalledWith(
      "s1",
      "file",
      "1:1",
      expect.anything(),
      expect.anything(),
    );
  });

  it("stays fully usable while the file is unlinked", () => {
    const { container } = render(makeNode({ id: "1:1", name: "Card" }));
    expect(container.querySelector('[data-testid="figma-inspect-panel"]')).not.toBeNull();
    expect(container.textContent ?? "").toContain("Card");
    expect(container.textContent ?? "").not.toContain("Link this file through the Figma plugin");
  });
});

describe("InspectPanel historical snapshot (32.5.4)", () => {
  let roots: Root[] = [];
  let containers: HTMLDivElement[] = [];

  beforeEach(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      value: true,
      configurable: true,
    });
    vi.stubGlobal("React", React);
    roots = [];
    containers = [];
  });

  afterEach(() => {
    for (const root of roots) act(() => root.unmount());
    for (const container of containers) container.remove();
    roots = [];
    containers = [];
    pendingQueueOps = [];
    fetchFigmaExportMock.mockReset();
    fetchFigmaExportMock.mockImplementation(async () => ({ file: null, fileName: null }));
  });

  interface HistOpts {
    disabled?: boolean;
    queue?: FigmaPendingOp[];
    applyEdits?: (ops: unknown[]) => Promise<void>;
  }

  function render(node: FigmaNode | null, opts: HistOpts = {}) {
    const view = renderPanel(node, undefined, opts);
    roots.push(view.root);
    containers.push(view.container);
    return {
      container: view.container,
      // Switch the selection on the SAME panel instance: a settle still in flight for the old
      // node must be retired by the identity guard, not painted onto the new selection.
      moveSelection: (next: FigmaNode, nextOpts: HistOpts = {}) => {
        pendingQueueOps = nextOpts.queue ?? opts.queue ?? [];
        act(() =>
          view.root.render(
            <InspectPanel
              serverId="s1"
              fileKey="file"
              node={next}
              linked={false}
              applyEdits={nextOpts.applyEdits ?? opts.applyEdits ?? vi.fn(async () => undefined)}
              disabled={nextOpts.disabled ?? opts.disabled}
            />,
          ),
        );
      },
    };
  }

  const toggle = (container: HTMLElement, label: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === label) as
      | HTMLButtonElement
      | undefined;

  const queueFor = () => [makePendingOp({ op: "rename", nodeId: "1:1", name: "Queued rename" })];

  it("keeps the live pending queue out of a disabled historical snapshot", () => {
    const historical = render(makeNode({ id: "1:1", name: "Card" }), {
      queue: queueFor(),
      disabled: true,
    });
    expect(
      historical.container.querySelector('[data-testid="figma-inspect-pending-note"]'),
    ).toBeNull();
    expect(
      historical.container.querySelectorAll('[data-testid="figma-edit-pending"]'),
    ).toHaveLength(0);
    const text = historical.container.textContent ?? "";
    expect(text).toContain("Card"); // the raw snapshot, not the queue preview
    expect(text).not.toContain("Queued rename");

    // Contrast on the same queue: the live panel previews and flags it.
    const live = render(makeNode({ id: "1:1", name: "Card" }), { queue: queueFor() });
    expect(
      live.container.querySelector('[data-testid="figma-inspect-pending-note"]'),
    ).not.toBeNull();
    expect(live.container.textContent ?? "").toContain("Queued rename");
  });

  it("disables every write control, visibility and lock toggles included", () => {
    const { container } = render(makeNode({ id: "1:1", name: "Card" }), { disabled: true });
    expect(toggle(container, "Visible")?.disabled).toBe(true);
    expect(toggle(container, "Unlocked")?.disabled).toBe(true);
    expect(toggle(container, "Row")?.disabled).toBe(true);
    expect(toggle(container, "None")?.disabled).toBe(true);
  });

  it("guards the apply callback too — a dispatched press cannot write to history", async () => {
    const applyEdits = vi.fn(async () => undefined);
    const { container } = render(makeNode({ id: "1:1", name: "Card" }), {
      disabled: true,
      applyEdits,
    });
    const button = toggle(container, "Visible") as HTMLButtonElement;
    // Dispatch instead of .click(): jsdom suppresses clicks on disabled buttons, and the point
    // here is that the handler itself refuses, not the DOM.
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(applyEdits).not.toHaveBeenCalled();
  });

  it("retires an async rejection that lands after the selection moved on", async () => {
    let rejectEdit!: (reason?: unknown) => void;
    const applyEdits = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          rejectEdit = reject;
        }),
    );
    const view = render(makeNode({ id: "1:1", name: "Card A" }), { applyEdits });
    await act(async () => {
      toggle(view.container, "Visible")?.click();
    });
    expect(applyEdits).toHaveBeenCalledTimes(1);
    // The user moves to another layer while the rejection is still in flight.
    view.moveSelection(makeNode({ id: "2:2", name: "Card B" }));
    await act(async () => {
      rejectEdit(new Error("Layer is locked"));
    });
    expect(view.container.querySelector('[data-testid="figma-edit-error"]')).toBeNull();

    // A rejection for the CURRENT selection still paints.
    const failing = vi.fn(async () => {
      throw new Error("boom on B");
    });
    view.moveSelection(makeNode({ id: "2:2", name: "Card B" }), { applyEdits: failing });
    await act(async () => {
      toggle(view.container, "Visible")?.click();
    });
    expect(
      view.container.querySelector('[data-testid="error-banner"]')?.textContent ?? "",
    ).toContain("boom on B");
  });
});
