// @vitest-environment jsdom
/**
 * Browse files (spec 32-figma §4, ADR-0038): the row walks the REAL flow —
 * the desktop bridge's native pick hands back a captured URL, which goes to
 * figma.files.add.request on the SELECTED connection, then the actual returned
 * file is opened and the real queries are invalidated. The only seams are the
 * Electron bridge and the daemon client; callFigma, queries and nav run
 * unmocked so a green suite means the wiring is real.
 */
import React, { type ReactNode } from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { router } from "expo-router";
import { BrowseFilesRow, BrowseGuidanceRow, canBrowseFigmaFiles } from "./browse-files";
import { useFigmaFiles } from "./queries";

const pickFile = vi.fn<() => Promise<{ kind: "file"; url: string } | { kind: "cancelled" }>>();
const figmaRequest = vi.fn();

vi.mock("@/desktop/host", () => ({
  getDesktopHost: () => ({ figma: { pickFile: () => pickFile() } }),
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: (serverId: string) => ({
    serverId,
    figmaRequest: (type: string, params: unknown) => figmaRequest(type, params),
  }),
}));

const FILE_KEY = "Kx7QmP2vTnYhW3cLd";
const PICKED_URL = `https://www.figma.com/design/${FILE_KEY}/HDC-APP-main?node-id=4-2`;

/** Daemon-side payloads keyed by RPC type; override per test with
 * mockImplementationOnce to inject `error` responses. */
function defaultResponses(): void {
  figmaRequest.mockImplementation((type: string) => {
    if (type === "figma.files.add.request") {
      return Promise.resolve({
        requestId: "r-add",
        file: {
          fileKey: FILE_KEY,
          connectionId: "c1",
          name: "HDC-APP/main",
          schemaVersion: 1,
          nodes: [],
        },
      });
    }
    if (type === "figma.files.list.request") {
      return Promise.resolve({ requestId: "r-list", files: [] });
    }
    return Promise.resolve({ requestId: "r" });
  });
}

beforeEach(() => {
  pickFile.mockReset();
  figmaRequest.mockReset();
  vi.mocked(router.setParams).mockClear();
  defaultResponses();
});

afterEach(cleanup);
afterAll(() => vi.unstubAllGlobals());

function renderBrowse(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

function clickBrowse() {
  fireEvent.click(screen.getByText("Browse files"));
}

const listCalls = () =>
  figmaRequest.mock.calls.filter(([type]) => type === "figma.files.list.request").length;

describe("Browse files (ADR-0038 primary add)", () => {
  it("offers Browse only when the desktop host exposes pickFile", () => {
    expect(canBrowseFigmaFiles()).toBe(true);
  });

  it("renders the Browse row for a connected desktop session", () => {
    renderBrowse(<BrowseFilesRow serverId="s1" connectionId="c1" />);
    expect(screen.getByText("Browse files")).toBeDefined();
  });

  it("treating a closed native picker as cancel does not add or navigate", async () => {
    pickFile.mockResolvedValue({ kind: "cancelled" });
    renderBrowse(<BrowseFilesRow serverId="s1" connectionId="c1" />);
    clickBrowse();
    await waitFor(() => expect(pickFile).toHaveBeenCalledTimes(1));
    expect(figmaRequest).not.toHaveBeenCalled();
    expect(router.setParams).not.toHaveBeenCalled();
  });

  it("adds the captured URL through the real RPC and opens the returned file", async () => {
    pickFile.mockResolvedValue({ kind: "file", url: PICKED_URL });
    renderBrowse(<BrowseFilesRow serverId="s1" connectionId="c1" />);
    clickBrowse();
    await waitFor(() =>
      expect(figmaRequest).toHaveBeenCalledWith(
        "figma.files.add.request",
        expect.objectContaining({ connectionId: "c1", url: PICKED_URL }),
      ),
    );
    // The actual file from the ADD RESPONSE is opened, and the captured
    // node-id survives the round-trip into the route.
    await waitFor(() =>
      expect(router.setParams).toHaveBeenCalledWith(
        expect.objectContaining({ fileKey: FILE_KEY, node: "4:2" }),
      ),
    );
  });

  it("invalidates the tracked-files query so the real list refetches", async () => {
    pickFile.mockResolvedValue({ kind: "file", url: PICKED_URL });
    function FilesProbe() {
      useFigmaFiles("s1", "c1");
      return null;
    }
    renderBrowse(
      <>
        <FilesProbe />
        <BrowseFilesRow serverId="s1" connectionId="c1" />
      </>,
    );
    await waitFor(() => expect(listCalls()).toBeGreaterThan(0));
    const before = listCalls();
    clickBrowse();
    await waitFor(() =>
      expect(figmaRequest).toHaveBeenCalledWith(
        "figma.files.add.request",
        expect.objectContaining({ connectionId: "c1" }),
      ),
    );
    await waitFor(() => expect(listCalls()).toBeGreaterThan(before));
  });

  it("blocks duplicate activations synchronously while a pick is in flight", async () => {
    let resolvePick: (value: { kind: "cancelled" }) => void = () => {};
    pickFile.mockReturnValue(new Promise((resolve) => (resolvePick = resolve)));
    renderBrowse(<BrowseFilesRow serverId="s1" connectionId="c1" />);
    const button = screen.getByText("Browse files");
    // Two activations dispatched in the SAME tick, before React can rerender
    // the disabled state: the synchronous busy gate must block the second.
    act(() => {
      button.click();
      button.click();
    });
    expect(pickFile).toHaveBeenCalledTimes(1);
    act(() => resolvePick({ kind: "cancelled" }));
  });

  it("shows a busy state while picking and clears it after the picker closes", async () => {
    let resolvePick: (value: { kind: "cancelled" }) => void = () => {};
    pickFile.mockReturnValue(new Promise((resolve) => (resolvePick = resolve)));
    renderBrowse(<BrowseFilesRow serverId="s1" connectionId="c1" />);
    clickBrowse();
    expect(screen.getByText("Opening Figma…")).toBeDefined();
    act(() => resolvePick({ kind: "cancelled" }));
    await waitFor(() => expect(screen.queryByText("Opening Figma…")).toBeNull());
  });

  it("drops a late pick after the row unmounted — no add, no navigation", async () => {
    let resolvePick: (value: { kind: "file"; url: string }) => void = () => {};
    pickFile.mockReturnValue(new Promise((resolve) => (resolvePick = resolve)));
    const view = renderBrowse(<BrowseFilesRow serverId="s1" connectionId="c1" />);
    clickBrowse();
    view.unmount();
    act(() => resolvePick({ kind: "file", url: PICKED_URL }));
    await waitFor(() => expect(pickFile).toHaveBeenCalledTimes(1));
    expect(figmaRequest).not.toHaveBeenCalled();
    expect(router.setParams).not.toHaveBeenCalled();
  });

  it("drops a late pick after the connection changed — added on the current context only", async () => {
    let resolvePick: (value: { kind: "file"; url: string }) => void = () => {};
    pickFile.mockReturnValue(new Promise((resolve) => (resolvePick = resolve)));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <BrowseFilesRow serverId="s1" connectionId="c1" />
      </QueryClientProvider>,
    );
    clickBrowse();
    view.rerender(
      <QueryClientProvider client={client}>
        <BrowseFilesRow serverId="s1" connectionId="c2" />
      </QueryClientProvider>,
    );
    act(() => resolvePick({ kind: "file", url: PICKED_URL }));
    await waitFor(() => expect(pickFile).toHaveBeenCalledTimes(1));
    expect(figmaRequest).not.toHaveBeenCalledWith("figma.files.add.request", expect.anything());
    expect(router.setParams).not.toHaveBeenCalled();
  });

  it("re-enables Browse after an account switch while a pick is unresolved, and the stale completion cannot unlock the fresh pick", async () => {
    type Pick = { kind: "file"; url: string } | { kind: "cancelled" };
    let resolveStale: (value: Pick) => void = () => {};
    let resolveFresh: (value: Pick) => void = () => {};
    pickFile
      .mockReturnValueOnce(new Promise((resolve) => (resolveStale = resolve)))
      .mockReturnValueOnce(new Promise((resolve) => (resolveFresh = resolve)));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <BrowseFilesRow serverId="s1" connectionId="c1" />
      </QueryClientProvider>,
    );
    clickBrowse();
    expect(screen.getByText("Opening Figma…")).toBeDefined();
    // Account/connection switch while the FIRST pick is still unresolved.
    view.rerender(
      <QueryClientProvider client={client}>
        <BrowseFilesRow serverId="s2" connectionId="c2" />
      </QueryClientProvider>,
    );
    // The stale pick owns nothing in the fresh context: Browse is usable again…
    await waitFor(() => expect(screen.getByText("Browse files")).toBeDefined());
    clickBrowse();
    // …and the fresh pick now owns the busy state.
    expect(screen.getByText("Opening Figma…")).toBeDefined();
    expect(pickFile).toHaveBeenCalledTimes(2);
    // The STALE completion lands: it must neither unlock the fresh busy state
    // nor add on the old context.
    act(() => resolveStale({ kind: "file", url: PICKED_URL }));
    await waitFor(() => expect(screen.getByText("Opening Figma…")).toBeDefined());
    expect(figmaRequest).not.toHaveBeenCalledWith(
      "figma.files.add.request",
      expect.objectContaining({ connectionId: "c1" }),
    );
    // The fresh pick completing is what unlocks.
    act(() => resolveFresh({ kind: "cancelled" }));
    await waitFor(() => expect(screen.getByText("Browse files")).toBeDefined());
    expect(router.setParams).not.toHaveBeenCalled();
  });

  it("errors without navigating when the add response carries no file", async () => {
    pickFile.mockResolvedValue({ kind: "file", url: PICKED_URL });
    figmaRequest.mockImplementation((type: string) => {
      if (type === "figma.files.add.request") return Promise.resolve({ requestId: "r-add" });
      if (type === "figma.files.list.request")
        return Promise.resolve({ requestId: "r-list", files: [] });
      return Promise.resolve({ requestId: "r" });
    });
    renderBrowse(<BrowseFilesRow serverId="s1" connectionId="c1" />);
    clickBrowse();
    await waitFor(() => expect(screen.getByTestId("figma-nav-browse-error")).toBeDefined());
    // No `?? target.fileKey` success fallback: a missing returned file is an error.
    expect(screen.getByTestId("figma-nav-browse-error").textContent).toMatch(/no file to open/i);
    expect(router.setParams).not.toHaveBeenCalled();
  });

  it("surfaces the daemon account/app message on a Figma 403 without blaming sharing", async () => {
    pickFile.mockResolvedValue({ kind: "file", url: PICKED_URL });
    figmaRequest.mockImplementationOnce(() =>
      Promise.resolve({
        requestId: "r-add",
        error: { code: "forbidden", message: "Figma denied the app API access (403)" },
      }),
    );
    renderBrowse(<BrowseFilesRow serverId="s1" connectionId="c1" />);
    clickBrowse();
    await waitFor(() => expect(screen.getByTestId("figma-nav-browse-error")).toBeDefined());
    expect(screen.getByTestId("figma-nav-browse-error").textContent).toContain("403");
    expect(screen.getByTestId("figma-nav-browse-error").textContent).not.toMatch(/sharing/i);
    expect(router.setParams).not.toHaveBeenCalled();
  });

  it("shows the real error when the picker returns a URL we cannot parse", async () => {
    pickFile.mockResolvedValue({ kind: "file", url: "https://example.com/not-figma" });
    renderBrowse(<BrowseFilesRow serverId="s1" connectionId="c1" />);
    clickBrowse();
    await waitFor(() => expect(screen.getByTestId("figma-nav-browse-error")).toBeDefined());
    expect(figmaRequest).not.toHaveBeenCalledWith("figma.files.add.request", expect.anything());
  });
});

describe("Browse guidance off desktop", () => {
  it("tells website/mobile sessions where to add files", () => {
    renderBrowse(<BrowseGuidanceRow />);
    expect(screen.getByTestId("figma-nav-browse-guidance").textContent).toMatch(
      /JAgentDesk desktop app/i,
    );
  });
});
