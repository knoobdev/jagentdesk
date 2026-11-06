// @vitest-environment jsdom
/**
 * The Figma home screen (spec 32.5). The header keeps Connections and drops the Figma Link
 * shortcut — Link is plugin setup, not a condition for viewing or playback, so it is reached
 * from the sidebar's advanced row and the link view gets an explicit Files back control. The
 * files home lists the daemon's actual tracked files and its empty state tells the truth per
 * surface: Browse files on the desktop, desktop-added guidance elsewhere (32.1, ADR-0038).
 */
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FigmaConnection, FigmaFile } from "@jagentdesk/protocol/figma/rpc-schemas";

// primitives imports expo-clipboard, whose build ships untranspilable JSX.
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => undefined) }));

const { queriesState, navState, browse, mocks } = vi.hoisted(() => ({
  queriesState: {
    connections: { data: [] as FigmaConnection[], isLoading: false, error: null as unknown },
    files: { data: [] as FigmaFile[], isLoading: false, error: null as unknown },
  },
  navState: {
    location: {
      connectionId: null as string | null,
      fileKey: null as string | null,
      pageId: null as string | null,
      nodeId: null as string | null,
      version: null as string | null,
      view: "files" as "files" | "connect" | "link",
    },
    go: vi.fn(),
  },
  browse: { current: true },
  mocks: {
    supportsFigma: true,
    linkPanelRendered: false,
    connectRendered: false,
    fileScreenProps: null as Record<string, unknown> | null,
  },
}));

vi.mock("@/figma/queries", () => ({
  useFigmaConnections: () => queriesState.connections,
  useFigmaFiles: () => queriesState.files,
}));
vi.mock("@/figma/nav", () => ({
  useFigmaNav: () => ({ location: navState.location, go: navState.go }),
  useFigmaGlobalNav: () => ({ location: navState.location, go: navState.go }),
}));
vi.mock("@/figma/browse-files", () => ({
  canBrowseFigmaFiles: () => browse.current,
  // The screen never renders the row itself; keep the module surface complete for imports.
  BrowseFilesRow: () => null,
  BrowseGuidanceRow: () => null,
  describeFigmaApiError: (error: unknown) => String(error),
}));
vi.mock("@/runtime/host-features", () => ({
  useHostFeature: () => mocks.supportsFigma,
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => [{ serverId: "srv1" }],
  useHostRuntimeClient: () => ({}),
}));
vi.mock("@/figma/connect/connect-screen", () => ({
  FigmaConnectScreen: ({ onConnected }: { onConnected?: () => void }) => {
    mocks.connectRendered = true;
    return (
      <button type="button" data-testid="figma-connect-stub" onClick={onConnected}>
        connect
      </button>
    );
  },
}));
vi.mock("@/figma/link/link-panel", () => ({
  FigmaLinkPanel: () => {
    mocks.linkPanelRendered = true;
    return <div data-testid="figma-link-panel-stub" />;
  },
}));
vi.mock("@/figma/canvas/file-screen", () => ({
  FigmaFileScreen: (props: Record<string, unknown>) => {
    mocks.fileScreenProps = props;
    return <div data-testid="figma-file-screen-stub" />;
  },
}));

// PageHeader ships no React default import (Metro's automatic JSX runtime), so the
// unit project's classic transform would crash it; tests the screen, not the header.
vi.mock("@/components/headers/page-header", () => ({
  PageHeader: ({ actions, testID }: Record<string, unknown>) => (
    <div data-testid={testID as string}>{actions as React.ReactNode}</div>
  ),
}));

import { FigmaScreen } from "./figma-screen";

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

function trackedFile(): FigmaFile {
  return {
    fileKey: "Kx7QmP2vTnYhW3cLd",
    connectionId: "fgc_1",
    name: "Checkout flow",
    pinned: true,
    linked: false,
  } as FigmaFile;
}

beforeEach(() => {
  browse.current = true;
  mocks.supportsFigma = true;
  mocks.linkPanelRendered = false;
  mocks.connectRendered = false;
  mocks.fileScreenProps = null;
  queriesState.connections = { data: [connection()], isLoading: false, error: null };
  queriesState.files = { data: [], isLoading: false, error: null };
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

describe("FigmaScreen header", () => {
  it("keeps Connections out of the way and drops the primary Figma Link shortcut", () => {
    render(<FigmaScreen />);
    expect(screen.queryByTestId("figma-open-link")).toBeNull();
    expect(screen.getByTestId("figma-open-connections")).toBeDefined();
    expect(mocks.linkPanelRendered).toBe(false);
  });

  it("shows an explicit Files back control while the advanced link view is open", () => {
    navState.location.view = "link";
    render(<FigmaScreen />);
    expect(mocks.linkPanelRendered).toBe(true);
    fireEvent.click(screen.getByTestId("figma-back-to-files"));
    expect(navState.go).toHaveBeenCalledWith({ view: "files" });
  });

  it("pressing Connections routes to the connect view", () => {
    render(<FigmaScreen />);
    fireEvent.click(screen.getByTestId("figma-open-connections"));
    expect(navState.go).toHaveBeenCalledWith({ view: "connect" });
  });
});

describe("FigmaScreen files home", () => {
  it("renders the actual tracked files", () => {
    queriesState.files = { data: [trackedFile()], isLoading: false, error: null };
    render(<FigmaScreen />);
    const card = screen.getByTestId("figma-file-Kx7QmP2vTnYhW3cLd");
    expect(card.textContent).toContain("Checkout flow");
    fireEvent.click(card);
    expect(navState.go).toHaveBeenCalledWith({
      fileKey: "Kx7QmP2vTnYhW3cLd",
      pageId: null,
      nodeId: null,
      version: null,
    });
  });

  it("empty desktop state points at Browse files, not URL pasting", () => {
    render(<FigmaScreen />);
    const empty = screen.getByTestId("figma-files-empty");
    expect(empty.textContent).toContain("No files yet");
    expect(empty.textContent).toContain("Browse files");
    expect(empty.textContent).not.toContain("by URL");
  });

  it("empty mobile state says files are added from the desktop app", () => {
    browse.current = false;
    render(<FigmaScreen />);
    const empty = screen.getByTestId("figma-files-empty");
    expect(empty.textContent).toContain("JAgentDesk desktop app");
    expect(empty.textContent).toContain("files already added");
  });

  it("the connected empty state guides to Browse files without a reconnect button", () => {
    render(<FigmaScreen />);
    const empty = screen.getByTestId("figma-files-empty");
    expect(empty.textContent).toContain("Browse files");
    expect(empty.textContent).toContain("JAgentDesk file picker");
    // Not the Figma Desktop app, and no second Connect competing with Browse.
    expect(empty.textContent).not.toContain("Figma window");
    expect(empty.textContent).not.toContain("Connect Figma");
    expect(screen.queryByTestId("figma-open-connect")).toBeNull();
  });

  it("shows the real file-list error", () => {
    queriesState.files = { data: [], isLoading: false, error: new Error("Figma limited requests") };
    render(<FigmaScreen />);
    expect(screen.getByTestId("figma-error")).toBeDefined();
    expect(screen.getByTestId("figma-error").textContent).toContain("Figma limited requests");
    expect(screen.queryByTestId("figma-files-empty")).toBeNull();
  });

  it("routes a fileKey to the file screen instead of the home", () => {
    navState.location.fileKey = "Kx7QmP2vTnYhW3cLd";
    navState.location.version = "v7";
    render(<FigmaScreen />);
    expect(screen.getByTestId("figma-file-screen-stub")).toBeDefined();
    expect(mocks.fileScreenProps).toMatchObject({
      serverId: "srv1",
      fileKey: "Kx7QmP2vTnYhW3cLd",
      version: "v7",
    });
  });

  it("without a connected account the connect guide is the home", () => {
    queriesState.connections = {
      data: [connection({ authState: "needs_reauth" })],
      isLoading: false,
      error: null,
    };
    render(<FigmaScreen />);
    expect(mocks.connectRendered).toBe(true);
    expect(screen.queryByTestId("figma-files-home")).toBeNull();
  });

  it("an unsupported host asks to update it", () => {
    mocks.supportsFigma = false;
    render(<FigmaScreen />);
    expect(screen.getByTestId("figma-no-host").textContent).toContain("Update the host");
  });
});
