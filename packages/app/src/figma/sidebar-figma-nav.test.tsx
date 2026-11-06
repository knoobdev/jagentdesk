// @vitest-environment jsdom
/**
 * The Figma sidebar column (spec 32.5) with Browse files as the primary add: the desktop bridge
 * shows the Browse files row (32.1, ADR-0038), everything else shows the honest desktop-selection
 * guidance instead of a fake picker, and the URL-paste rows sit under an explicit Advanced
 * disclosure rather than the primary journey. The lists render the daemon's actual tracked files
 * (pinned/recent, teams, the active file row); empty and error states reflect what the queries
 * really returned — no invented all-files list.
 */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { FigmaConnection, FigmaFile, FigmaTeam } from "@jagentdesk/protocol/figma/rpc-schemas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { bridge, queriesState, navState, host, calls } = vi.hoisted(() => ({
  bridge: { current: null as { figma?: { pickFile?: () => Promise<unknown> } } | null },
  queriesState: {
    connections: { data: [] as FigmaConnection[], isLoading: false, error: null as unknown },
    files: { data: [] as FigmaFile[], isLoading: false, error: null as unknown },
    teams: { data: [] as FigmaTeam[], isLoading: false, error: null as unknown },
    teamProjects: { data: [] as unknown[], isLoading: false, error: null as unknown },
    teamFiles: { data: [] as unknown[], isLoading: false, error: null as unknown },
    outline: { data: null as unknown, isLoading: false, error: null as unknown },
    nodes: { data: null as unknown, isLoading: false, error: null as unknown },
    sectionChildren: { data: null as unknown, isLoading: false, error: null as unknown },
    linkStatus: { data: undefined as unknown, isLoading: false, error: null as unknown },
    invalidated: [] as string[],
  },
  navState: {
    location: {
      connectionId: "fgc_1" as string | null,
      fileKey: null as string | null,
      pageId: null as string | null,
      nodeId: null as string | null,
      version: null as string | null,
      view: "files" as "files" | "connect" | "link",
    },
    go: vi.fn(),
  },
  // server_info.features the sidebar gates on (ADR-0039 figmaNodeDepth).
  host: { figmaNodeDepth: true },
  calls: {
    nodes: [] as unknown[][],
    sectionChildren: [] as unknown[][],
  },
}));

// Plain-DOM RN shim: rows expose their accessibility contract as data attributes so the active
// row, the browse row, and the disclosure are readable without react-native-web's style pipeline.
vi.mock("react-native", () => {
  const node =
    (tag: string) =>
    ({
      children,
      testID,
      onPress,
      onLongPress,
      accessibilityRole,
      accessibilityState,
      accessibilityLabel,
      style,
      value,
      placeholder,
    }: Record<string, unknown>) =>
      React.createElement(
        tag,
        {
          "data-testid": testID as string,
          role: (accessibilityRole ?? undefined) as string | undefined,
          "data-accessibility-state": accessibilityState
            ? JSON.stringify(accessibilityState)
            : undefined,
          "aria-selected":
            accessibilityState &&
            (accessibilityState as { selected?: unknown }).selected !== undefined
              ? String(Boolean((accessibilityState as { selected?: unknown }).selected))
              : undefined,
          "aria-label": (accessibilityLabel ?? undefined) as string | undefined,
          "data-style": style ? JSON.stringify(style) : undefined,
          onClick: (onPress ?? onLongPress) as (() => void) | undefined,
          value: (value ?? undefined) as string | undefined,
          placeholder: (placeholder ?? undefined) as string | undefined,
        },
        children as React.ReactNode,
      );
  return {
    Platform: {
      OS: "web",
      select: (options: Record<string, unknown>) =>
        "web" in options ? options.web : options.default,
    },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    View: node("div"),
    Text: node("span"),
    ScrollView: node("div"),
    TextInput: node("input"),
    Pressable: node("div"),
  };
});

vi.mock("@/desktop/host", () => ({ getDesktopHost: () => bridge.current }));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({ figmaRequest: vi.fn() }),
}));
vi.mock("@/runtime/host-features", () => ({
  useHostFeature: (_serverId: string, feature: string) =>
    feature === "figmaNodeDepth" && host.figmaNodeDepth,
}));
vi.mock("@/figma/api", () => ({
  callFigma: vi.fn(async () => ({})),
  errorMessage: (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
}));
vi.mock("@/figma/nav", () => ({
  useFigmaGlobalNav: () => ({ location: navState.location, go: navState.go }),
  useFigmaNav: () => ({ location: navState.location, go: navState.go }),
}));
vi.mock("@/figma/queries", () => {
  const query = (key: keyof typeof queriesState) => () => queriesState[key];
  return {
    useFigmaConnections: query("connections"),
    useFigmaFiles: query("files"),
    useFigmaTeams: query("teams"),
    useFigmaTeamProjects: query("teamProjects"),
    useFigmaTeamFiles: query("teamFiles"),
    useFigmaOutline: query("outline"),
    useFigmaLinkStatus: query("linkStatus"),
    // Real-argument recorders: the ADR-0039 tests assert WHICH node each read
    // was asked for (full tree vs shallow depth-1), not just that it ran.
    useFigmaNodes: (...args: unknown[]) => {
      calls.nodes.push(args);
      return queriesState.nodes;
    },
    useFigmaSectionChildren: (...args: unknown[]) => {
      calls.sectionChildren.push(args);
      return queriesState.sectionChildren;
    },
    invalidateFigmaFiles: (_queryClient: unknown, serverId: string) =>
      queriesState.invalidated.push(serverId),
  };
});

import { SidebarFigmaNav } from "./sidebar-figma-nav";

function connection(overrides: Partial<FigmaConnection> = {}): FigmaConnection {
  return {
    id: "fgc_1",
    account: { figmaUserId: "123", handle: "knoob", email: "dev@knoob.io" },
    authState: "connected",
    tokenExpiresAt_ms: Date.now() + 86_400_000,
    createdAt_ms: 1,
    ...overrides,
  } as FigmaConnection;
}

function file(overrides: Partial<FigmaFile>): FigmaFile {
  return {
    fileKey: "Kx7QmP2vTnYhW3cLd",
    connectionId: "fgc_1",
    name: "Checkout flow",
    pinned: false,
    linked: false,
    ...overrides,
  } as FigmaFile;
}

function renderNav() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SidebarFigmaNav serverId="srv1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  bridge.current = { figma: { pickFile: async () => ({ kind: "cancelled" as const }) } };
  queriesState.connections = { data: [connection()], isLoading: false, error: null };
  queriesState.files = { data: [], isLoading: false, error: null };
  queriesState.teams = { data: [], isLoading: false, error: null };
  queriesState.teamProjects = { data: [], isLoading: false, error: null };
  queriesState.teamFiles = { data: [], isLoading: false, error: null };
  queriesState.outline = { data: null, isLoading: false, error: null };
  queriesState.nodes = { data: null, isLoading: false, error: null };
  queriesState.sectionChildren = { data: null, isLoading: false, error: null };
  queriesState.linkStatus = { data: undefined, isLoading: false, error: null };
  queriesState.invalidated = [];
  host.figmaNodeDepth = true;
  calls.nodes = [];
  calls.sectionChildren = [];
  navState.location = {
    connectionId: "fgc_1",
    fileKey: null,
    pageId: null,
    nodeId: null,
    version: null,
    view: "files",
  };
  navState.go.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("SidebarFigmaNav — Browse files primary", () => {
  it("shows Browse files, not the URL rows, when the desktop bridge offers the picker", () => {
    renderNav();
    expect(screen.getByTestId("figma-nav-browse").textContent).toContain("Browse files");
    expect(screen.queryByTestId("figma-nav-add-file-open")).toBeNull();
    expect(screen.queryByTestId("figma-nav-add-team-open")).toBeNull();
  });

  it("shows the desktop-selection guidance when there is no picker (mobile / plain web)", () => {
    bridge.current = null;
    renderNav();
    const guidance = screen.getByTestId("figma-nav-browse-guidance");
    expect(guidance.textContent).toContain("JAgentDesk desktop app");
    expect(guidance.textContent).toContain("files already added");
    expect(screen.queryByTestId("figma-nav-browse")).toBeNull();
  });

  it("keeps the URL-paste rows as explicit Advanced access only", async () => {
    renderNav();
    expect(screen.queryByTestId("figma-nav-add-file-open")).toBeNull();
    fireEvent.click(screen.getByTestId("figma-nav-advanced"));
    await waitFor(() => expect(screen.getByTestId("figma-nav-add-file-open")).toBeDefined());
    expect(screen.getByTestId("figma-nav-add-team-open")).toBeDefined();
  });
});

describe("SidebarFigmaNav — tracked files", () => {
  it("renders pinned and recent rows from the actual file list", () => {
    queriesState.files = {
      data: [
        file({ fileKey: "pinnedKey12345", name: "Design system", pinned: true }),
        file({ fileKey: "recentKey123456", name: "Onboarding", lastOpenedAt_ms: 5 }),
        file({ fileKey: "olderKey123456", name: "Archive", lastOpenedAt_ms: 1 }),
      ],
      isLoading: false,
      error: null,
    };
    renderNav();
    expect(screen.getByTestId("figma-nav-file-pinnedKey12345")).toBeDefined();
    expect(screen.getByTestId("figma-nav-file-recentKey123456")).toBeDefined();
    expect(screen.getByTestId("figma-nav-file-olderKey123456")).toBeDefined();
  });

  it("marks the open file row active from the route", () => {
    queriesState.files = {
      data: [file({ fileKey: "openKey1234567" })],
      isLoading: false,
      error: null,
    };
    navState.location.fileKey = "openKey1234567";
    renderNav();
    const row = screen.getByTestId("figma-nav-file-openKey1234567");
    expect(row.getAttribute("aria-selected")).toBe("true");
  });

  it("states the real empty list with where files come from", () => {
    renderNav();
    expect(screen.getByTestId("figma-nav-files-empty").textContent).toContain("Browse files");
  });

  it("shows the file query error instead of an empty list", () => {
    queriesState.files = { data: [], isLoading: false, error: new Error("Host offline") };
    renderNav();
    expect(screen.getByText("Host offline")).toBeDefined();
    expect(screen.queryByTestId("figma-nav-files-empty")).toBeNull();
  });

  it("renders teams under a Teams label and their real empty state", () => {
    queriesState.teams = {
      data: [{ teamId: "12345", connectionId: "fgc_1", name: "HDC" } as FigmaTeam],
      isLoading: false,
      error: null,
    };
    const { unmount } = renderNav();
    expect(screen.getByText("Teams")).toBeDefined();
    expect(screen.getByTestId("figma-nav-team-12345")).toBeDefined();
    expect(screen.queryByTestId("figma-nav-teams-empty")).toBeNull();
    unmount();
    queriesState.teams = { data: [], isLoading: false, error: null };
    renderNav();
    expect(screen.getByTestId("figma-nav-teams-empty").textContent).toContain("Advanced");
  });

  it("keeps the explicit Figma Link row for the advanced integration view", () => {
    renderNav();
    fireEvent.click(screen.getByTestId("figma-nav-link"));
    expect(navState.go).toHaveBeenCalledWith({ view: "link" });
  });
});

// ── ADR-0039 — Section outline tree ─────────────────────────────────────────
function summary(
  id: string,
  type: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    name: `${type} ${id}`,
    type,
    bounds: { x: 0, y: 0, width: 240, height: 160 },
    ...overrides,
  };
}

function openOutline(pages: Record<string, unknown>[], version = "147:0a9b") {
  return {
    data: {
      fileKey: "Kx7QmP2vTnYhW3cLd",
      name: "HDC-APP/main",
      version,
      lastModified_ms: 1,
      editorType: "figma",
      source: "rest",
      pages,
    },
    isLoading: false,
    error: null,
  };
}

function page(id: string, frames: Record<string, unknown>[], name = "Page 1") {
  return { id, name, frames, flowStartingPoints: [] };
}

function openFile(pageId = "0:1") {
  navState.location.fileKey = "Kx7QmP2vTnYhW3cLd";
  navState.location.pageId = pageId;
}

const shallowSection = (sectionId: string, children: Record<string, unknown>[]) => ({
  data: {
    version: "147:0a9b",
    source: "rest",
    nodes: { [sectionId]: { id: sectionId, type: "SECTION", children } },
  },
  isLoading: false,
  error: null,
});

describe("SidebarFigmaNav — Section outline (ADR-0039)", () => {
  it("renders the hierarchy strictly by parentId — section children nest under the section, roots stay roots", () => {
    openFile();
    queriesState.outline = openOutline([
      page("0:1", [
        summary("1:1", "FRAME"),
        summary("1:2", "SECTION", { childrenLoaded: true }),
        summary("1:3", "FRAME", { parentId: "1:2" }),
      ]),
    ]);
    renderNav();
    fireEvent.click(screen.getByTestId("figma-nav-section-1:2"));
    const nested = screen.getByTestId("figma-nav-frame-1:3");
    const root = screen.getByTestId("figma-nav-frame-1:1");
    // parentId places the child one indent level below its section; a root row
    // keeps the page-child indent.
    expect(JSON.parse(nested.getAttribute("data-style") ?? "[]")[1].paddingLeft).toBeGreaterThan(
      JSON.parse(root.getAttribute("data-style") ?? "[]")[1].paddingLeft,
    );
  });

  it("expands a childrenLoaded section from the outline summaries with NO node fetch", () => {
    openFile();
    queriesState.outline = openOutline([
      page("0:1", [
        summary("2:1", "SECTION", { childrenLoaded: true }),
        summary("2:2", "FRAME", { parentId: "2:1" }),
      ]),
    ]);
    renderNav();
    fireEvent.click(screen.getByTestId("figma-nav-section-2:1"));
    expect(screen.getByTestId("figma-nav-frame-2:2")).toBeDefined();
    // The section never touches the full-subtree query, and nothing shallow either
    // (the hook stays IDLE with a null target when the children are known).
    expect(calls.nodes.some(([, , ids]) => (ids as string[]).includes("2:1"))).toBe(false);
    expect(calls.sectionChildren.filter(([, , id]) => id !== null)).toEqual([]);
  });

  it("fetches an unknown section's children with the depth-1 helper on the outline's pinned version, and only on expand", () => {
    openFile();
    queriesState.outline = openOutline([
      page("0:1", [summary("3:1", "SECTION", { childrenLoaded: false })]),
    ]);
    renderNav();
    // Opening the file must not prefetch every section — no id-targeted request.
    expect(calls.sectionChildren.filter(([, , id]) => id !== null)).toEqual([]);
    queriesState.sectionChildren = shallowSection("3:1", [
      summary("3:2", "FRAME"),
      summary("3:3", "SECTION"),
    ]);
    fireEvent.click(screen.getByTestId("figma-nav-section-3:1"));
    expect(calls.sectionChildren).toContainEqual(["srv1", "Kx7QmP2vTnYhW3cLd", "3:1", "147:0a9b"]);
    // The helper returns REAL child summaries; nested frames render as frame rows.
    expect(screen.getByTestId("figma-nav-frame-3:2")).toBeDefined();
    expect(screen.getByTestId("figma-nav-section-3:3")).toBeDefined();
  });

  it("recurses: expanding a nested section from a depth-1 result fires another depth-1 read", () => {
    openFile();
    queriesState.outline = openOutline([page("0:1", [summary("4:1", "SECTION")])]);
    queriesState.sectionChildren = shallowSection("4:1", [summary("4:2", "SECTION")]);
    renderNav();
    fireEvent.click(screen.getByTestId("figma-nav-section-4:1"));
    fireEvent.click(screen.getByTestId("figma-nav-section-4:2"));
    expect(calls.sectionChildren).toContainEqual(["srv1", "Kx7QmP2vTnYhW3cLd", "4:2", "147:0a9b"]);
  });

  it("loads a REAL frame's full tree only when the user expands the frame", () => {
    openFile();
    queriesState.outline = openOutline([page("0:1", [summary("5:1", "FRAME")])]);
    queriesState.nodes = {
      data: {
        version: "147:0a9b",
        nodes: {
          "5:1": {
            id: "5:1",
            type: "FRAME",
            children: [{ id: "5:2", type: "TEXT", name: "Label" }],
          },
        },
      },
      isLoading: false,
      error: null,
    };
    renderNav();
    expect(calls.nodes.some(([, , ids]) => (ids as string[]).includes("5:1"))).toBe(false);
    fireEvent.click(screen.getByTestId("figma-nav-frame-5:1"));
    expect(calls.nodes.some(([, , ids]) => (ids as string[]).includes("5:1"))).toBe(true);
    expect(screen.getByTestId("figma-nav-layer-5:2")).toBeDefined();
  });

  it("disables unknown sections with an update hint when the host lacks figmaNodeDepth — no full-Section fallback", () => {
    host.figmaNodeDepth = false;
    openFile();
    queriesState.outline = openOutline([
      page("0:1", [summary("6:1", "SECTION", { childrenLoaded: false })]),
    ]);
    renderNav();
    fireEvent.click(screen.getByTestId("figma-nav-section-6:1"));
    // No shallow request is even attempted; the hint tells the user why.
    expect(calls.sectionChildren.filter(([, , id]) => id === "6:1")).toEqual([]);
    expect(calls.nodes.some(([, , ids]) => (ids as string[]).includes("6:1"))).toBe(false);
    expect(screen.getByTestId("figma-nav-section-6:1-update-hint").textContent).toMatch(
      /update the host/i,
    );
  });

  it("renders flows only when the outline carried them and never fabricates a full list", () => {
    openFile();
    queriesState.outline = openOutline([page("0:1", [summary("7:1", "FRAME")])]);
    renderNav();
    // flowStartingPoints absent from the page → no flow chrome invented.
    expect(screen.queryByText(/flow/i)).toBeNull();
  });
});
