/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FigmaComponentMeta, FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import { makeNode } from "./__fixtures__/figma";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
    colors: {
      surface0: "#0a0a0a",
      surface1: "#111",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      foregroundExtraMuted: "#777",
      border: "#555",
      accent: "#0a84ff",
      statusSuccess: "#00ff00",
      statusWarning: "#ff9500",
      statusDanger: "#ff0000",
      palette: { red: { 300: "#ff6b6b" }, white: "#fff" },
    },
  },
}));

vi.mock("react-native", () => ({
  Platform: { OS: "web" },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("div", { "data-testid": testID }, children),
  Text: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("span", null, children),
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
  ErrorBanner: ({ message }: { message: string }) =>
    React.createElement("span", { "data-testid": "error-banner" }, message),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("button", { type: "button" }, children),
}));

vi.mock("lucide-react-native", () => {
  const icon = (name: string) => () => React.createElement("span", { "data-icon": name });
  return {
    Copy: icon("Copy"),
    Download: icon("Download"),
    Eye: icon("Eye"),
    EyeOff: icon("EyeOff"),
    Lock: icon("Lock"),
    Unlock: icon("Unlock"),
  };
});

vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => undefined) }));

vi.mock("./use-figma-file", () => ({
  fetchFigmaExport: vi.fn(async () => ({ file: null, fileName: null })),
}));

vi.mock("./save-bytes", () => ({ saveExportedBytes: vi.fn(async () => undefined) }));

import { InspectPanel } from "./inspect-panel";
import { PANEL_LABEL_WIDTH } from "./panel-ui";

function renderPanel(
  node: FigmaNode | null,
  componentMeta?: (id: string) => FigmaComponentMeta | undefined,
  opts?: {
    parentOf?: (id: string) => FigmaNode | null | undefined;
    applyEdits?: (ops: unknown[]) => Promise<void>;
  },
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(
      <InspectPanel
        serverId="s1"
        fileKey="file"
        node={node}
        linked={false}
        applyEdits={opts?.applyEdits ?? vi.fn(async () => undefined)}
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
      applyEdits?: (ops: unknown[]) => Promise<void>;
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

  it("shows the component id when no metadata has loaded yet", () => {
    const { container } = render(makeNode({ componentId: "5:2" }), () => undefined);
    const text = container.textContent ?? "";
    expect(text).toContain("5:2");
    expect(text).toContain("Local component");
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
