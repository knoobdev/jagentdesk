/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { theme, linkState } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
    colors: {
      surface0: "#0a0a0a",
      surface1: "#111",
      surface2: "#222",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      foregroundExtraMuted: "#777",
      border: "#555",
      accent: "#0a84ff",
      statusSuccess: "#00ff00",
      statusWarning: "#ff9500",
      statusDanger: "#ff0000",
    },
    fontSize: { xs: 11, sm: 13, base: 15, lg: 18 },
    fontWeight: { medium: "500", semibold: "600" },
    borderRadius: { sm: 4, md: 6, lg: 8 },
    fontFamily: { mono: "monospace" },
  },
  linkState: { data: undefined as unknown },
}));

vi.mock("react-native", () => ({
  Platform: { OS: "web" },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  View: ({
    children,
    testID,
    style,
  }: {
    children?: React.ReactNode;
    testID?: string;
    style?: { gap?: number };
  }) =>
    React.createElement(
      "div",
      {
        "data-testid": testID,
        "data-gap": style?.gap === undefined ? undefined : String(style.gap),
      },
      children,
    ),
  Text: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("span", { "data-testid": testID }, children),
  TextInput: (props: { placeholder?: string; accessibilityLabel?: string; testID?: string }) =>
    React.createElement("input", {
      "data-testid": props.testID,
      placeholder: props.placeholder ?? "",
      "aria-label": props.accessibilityLabel ?? "",
      readOnly: true,
    }),
  Switch: ({ testID }: { testID?: string }) =>
    React.createElement("input", { type: "checkbox", "data-testid": testID }),
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

vi.mock("@/constants/platform", () => ({
  isWeb: true,
  isNative: false,
  getIsElectron: () => false,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("button", { type: "button", "data-testid": testID }, children),
}));

vi.mock("lucide-react-native", () => {
  const icon = (name: string) => () => React.createElement("span", { "data-icon": name });
  return {
    Check: icon("Check"),
    ChevronDown: icon("ChevronDown"),
    ChevronRight: icon("ChevronRight"),
    CircleAlert: icon("CircleAlert"),
    Copy: icon("Copy"),
    Loader2: icon("Loader2"),
  };
});

vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => undefined) }));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({}),
}));

vi.mock("@/figma/api", () => ({
  callFigma: vi.fn(async () => ({})),
  errorMessage: (cause: unknown) => String(cause),
}));

vi.mock("@/figma/queries", () => ({
  useFigmaLinkStatus: () => ({
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    data: linkState.data,
  }),
  useFigmaLinkPushInvalidator: () => undefined,
}));

import { FigmaLinkPanel } from "./link-panel";

function baseStatus(overrides: Record<string, unknown> = {}) {
  return {
    server: "listening",
    port: 1995,
    pluginInstalled: true,
    pluginVersion: "1.2.3",
    manifestPath: "/Users/dev/.jagentdesk/figma/plugin/manifest.json",
    runScriptEnabled: true,
    files: [],
    pendingPairing: null,
    ...overrides,
  };
}

describe("FigmaLinkPanel", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      value: true,
      configurable: true,
    });
    vi.stubGlobal("React", React);
    linkState.data = baseStatus();
  });

  afterEach(() => {
    if (root) {
      const mounted = root;
      act(() => mounted.unmount());
    }
    root = null;
    container?.remove();
    container = null;
  });

  function render() {
    container = document.createElement("div");
    document.body.appendChild(container);
    const mounted = createRoot(container);
    root = mounted;
    act(() => mounted.render(<FigmaLinkPanel serverId="s1" />));
    return container;
  }

  it("uses a neutral muted hint for the pairing code, not a value-shaped '123456'", () => {
    const view = render();
    const code = view.querySelector('[data-testid="figma-link-code"]') as HTMLInputElement;
    expect(code.getAttribute("placeholder")).toBe("6-digit code");
  });

  it("always shows the manifest path with Copy while the plugin reads as installed", () => {
    const view = render();
    expect(view.textContent ?? "").toContain("Installed · v1.2.3");
    expect(view.querySelector('[data-testid="figma-link-manifest"]')).not.toBeNull();
    expect(view.textContent ?? "").toContain("/Users/dev/.jagentdesk/figma/plugin/manifest.json");
    expect(view.querySelector('[data-testid="figma-link-manifest-copy"]')).not.toBeNull();
    expect(view.querySelector('[data-testid="figma-link-import-toggle"]')).not.toBeNull();
    expect(view.querySelector('[data-testid="figma-link-import-steps"]')).toBeNull();
  });

  it("reveals the import steps only when the disclosure row is expanded", () => {
    const view = render();
    act(() => {
      view
        .querySelector('[data-testid="figma-link-import-toggle"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const steps = view.querySelector('[data-testid="figma-link-import-steps"]');
    expect(steps).not.toBeNull();
    expect(steps?.textContent ?? "").toContain(
      "Plugins → Development → Import plugin from manifest",
    );
  });

  it("shows the manifest path and Not installed together when the plugin is missing", () => {
    linkState.data = baseStatus({ pluginInstalled: false, pluginVersion: null });
    const view = render();
    console.info(view.outerHTML.slice(0, 4000));
    expect(view.querySelector('[data-testid="figma-link-plugin-state"]')?.textContent).toBe(
      "Not installed",
    );
    expect(view.querySelector('[data-testid="figma-link-manifest"]')).not.toBeNull();
    expect(view.textContent ?? "").toContain("/Users/dev/.jagentdesk/figma/plugin/manifest.json");
  });

  it("explains when the manifest path is host-only", () => {
    linkState.data = baseStatus({ manifestPath: null });
    const view = render();
    expect(view.textContent ?? "").toContain(
      "The manifest path is only available on the host machine.",
    );
  });
});
