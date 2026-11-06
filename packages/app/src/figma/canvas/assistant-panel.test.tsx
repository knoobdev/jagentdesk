/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { theme, runtime } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
    fontSize: { xs: 11, sm: 13, base: 15, lg: 17 },
    fontWeight: { normal: "400", medium: "500", semibold: "600" },
    borderRadius: { sm: 4, md: 6, lg: 8, full: 9999 },
    borderWidth: { 1: 1 },
    fontFamily: { mono: "monospace" },
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
  },
  runtime: {
    client: null as unknown,
    providerEntries: [] as Array<{ enabled: boolean; provider: string }>,
    workspaces: undefined as unknown,
    agents: undefined as unknown,
    workspaceDirectory: null as string | null,
  },
}));

vi.mock("react-native", () => ({
  Platform: { OS: "web" },
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("div", { "data-testid": testID }, children),
  Text: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("span", { "data-testid": testID }, children),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
  },
  useUnistyles: () => ({ theme, rt: { breakpoint: "md" } }),
  withUnistyles: <T,>(component: T) => component,
}));

vi.mock("lucide-react-native", () => {
  const icon = () => () => React.createElement("i");
  return { ArrowLeft: icon(), MessageSquare: icon(), Plus: icon(), X: icon() };
});

vi.mock("@/panels/agent-panel", () => ({
  AgentConversationPanel: () => React.createElement("div", { "data-testid": "agent-conversation" }),
}));

vi.mock("@/panels/pane-context", () => ({
  createPaneFocusContextValue: (value: unknown) => value,
  PaneFocusProvider: ({ children }: { children?: React.ReactNode }) => children,
  PaneProvider: ({ children }: { children?: React.ReactNode }) => children,
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => runtime.client,
}));

vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({ entries: runtime.providerEntries }),
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({
      sessions: {
        s1: {
          workspaces: runtime.workspaces,
          agents: runtime.agents,
          viewedTimelineSync: null,
        },
      },
    }),
}));

vi.mock("@/jira/ui/styles", () => {
  const style = new Proxy({}, { get: () => ({}) });
  return { jiraStyles: style };
});

vi.mock("@/jira/ui/primitives", () => ({
  EmptyState: ({ title, body }: { title: string; body?: string }) =>
    React.createElement(
      "div",
      { "data-testid": "empty-state" },
      React.createElement("span", null, title),
      body ? React.createElement("span", null, body) : null,
    ),
  IconButton: ({
    label,
    onPress,
    testID,
  }: {
    label: string;
    onPress?: () => void;
    testID?: string;
  }) =>
    React.createElement(
      "button",
      { type: "button", "data-testid": testID ?? label, onClick: onPress },
      label,
    ),
  tint: { muted: () => ({}) },
}));

vi.mock("@/jira/assistant/workspaces", () => ({
  firstWorkspaceDirectory: () => runtime.workspaceDirectory,
}));

vi.mock("./assistant-draft", () => ({
  FigmaAssistantDraft: (props: { cwd: string | null }) =>
    React.createElement("div", { "data-testid": "assistant-draft" }, String(props.cwd)),
}));

import {
  FIGMA_ASSISTANT_LABEL,
  FIGMA_ASSISTANT_SCOPE_LABEL,
  figmaAssistantScope,
  type FigmaAssistantContext,
} from "./assistant-context";
import { FigmaAssistantPanel } from "./assistant-panel";

const CONTEXT: FigmaAssistantContext = {
  serverId: "s1",
  fileKey: "file",
  fileName: "Design file",
  pageId: "p1",
  nodeId: "1:5",
};

describe("FigmaAssistantPanel", () => {
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
    runtime.client = { id: 1 };
    runtime.providerEntries = [{ enabled: true, provider: "claude" }];
    runtime.workspaces = new Map();
    runtime.agents = new Map();
    runtime.workspaceDirectory = "/work/proj";
  });

  afterEach(() => {
    for (const root of roots) act(() => root.unmount());
    for (const container of containers) container.remove();
    roots = [];
    containers = [];
  });

  function render() {
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);
    roots.push(root);
    act(() => {
      root.render(
        <FigmaAssistantPanel serverId="s1" context={CONTEXT} isCompact={false} onClose={vi.fn()} />,
      );
    });
    return container;
  }

  it("points at Host settings when no AI provider is enabled (nothing about Figma Link)", () => {
    runtime.providerEntries = [];
    const container = render();
    const text = container.textContent ?? "";
    expect(text).toContain("Turn on an AI provider in Host settings.");
    expect(text).not.toContain("workspace");
    expect(container.querySelector('[data-testid="assistant-draft"]')).toBeNull();
  });

  it("points at a workspace when a provider is on but the project has none", () => {
    runtime.workspaceDirectory = null;
    const container = render();
    expect(container.textContent ?? "").toContain(
      "Open a workspace first — the assistant runs inside a project's workspace.",
    );
  });

  it("renders the scoped draft once client, provider and workspace are ready", () => {
    const container = render();
    expect(container.querySelector('[data-testid="assistant-draft"]')?.textContent).toContain(
      "/work/proj",
    );
    expect(container.textContent ?? "").toContain("Design file · 1:5");
  });

  it("reopens the existing assistant for this scope and New chat returns to the draft", () => {
    const scope = figmaAssistantScope(CONTEXT);
    runtime.agents = new Map([
      [
        "a1",
        {
          id: "a1",
          labels: { [FIGMA_ASSISTANT_LABEL]: "true", [FIGMA_ASSISTANT_SCOPE_LABEL]: scope },
          lastActivityAt: 5,
          workspaceId: "w1",
        },
      ],
    ]);
    const container = render();
    expect(container.querySelector('[data-testid="agent-conversation"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="assistant-draft"]')).toBeNull();

    act(() => {
      (container.querySelector('[data-testid="figma-assistant-new"]') as HTMLButtonElement).click();
    });
    expect(container.querySelector('[data-testid="agent-conversation"]')).toBeNull();
    expect(container.querySelector('[data-testid="assistant-draft"]')).not.toBeNull();
  });

  it("ignores archived and other-scope assistants", () => {
    runtime.agents = new Map([
      [
        "old",
        {
          id: "old",
          labels: {
            [FIGMA_ASSISTANT_LABEL]: "true",
            [FIGMA_ASSISTANT_SCOPE_LABEL]: figmaAssistantScope(CONTEXT),
          },
          lastActivityAt: 9,
          archivedAt: 1,
        },
      ],
      [
        "other",
        {
          id: "other",
          labels: { [FIGMA_ASSISTANT_LABEL]: "true", [FIGMA_ASSISTANT_SCOPE_LABEL]: "different" },
          lastActivityAt: 9,
        },
      ],
    ]);
    const container = render();
    expect(container.querySelector('[data-testid="agent-conversation"]')).toBeNull();
    expect(container.querySelector('[data-testid="assistant-draft"]')).not.toBeNull();
  });
});
