// @vitest-environment jsdom
/**
 * Retention-boundary regression for the Figma query helpers (spec 32.5.1).
 * The full-subtree helper's ONLY consumer is the sidebar FrameRow, and a
 * collapse or a selection change detaches its observer immediately — under
 * TanStack's 5-minute default gcTime every expanded frame's tree would then
 * sit in the app cache outside the FrameStore LRU. These tests run the REAL
 * `useFetchQuery` hooks against a REAL `QueryClient`; only the daemon RPC is
 * mocked, and every assertion reads the cache itself, not an options literal:
 * the collapsed full subtree is RELEASED on the very next GC tick while the
 * unobserved shallow/outline entries (policy unchanged) survive the same
 * tick, the still-active frame keeps its data, and re-expanding requests the
 * daemon again on the pinned version — the daemon's per-version cache serves
 * revisits, not app history.
 */
import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { figmaKeys, useFigmaNodes, useFigmaOutline, useFigmaSectionChildren } from "./queries";

const { figmaRequest } = vi.hoisted(() => ({ figmaRequest: vi.fn() }));

// RPC-data-only seam: callFigma, useFetchQuery and the QueryClient are real.
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({
    figmaRequest: (type: string, params: unknown) => figmaRequest(type, params),
  }),
}));

const SERVER = "srv1";
const FILE_KEY = "Kx7QmP2vTnYhW3cLd";
const VERSION = "147:0a9b";
const COLLAPSED_FRAME = "5:1";
const ACTIVE_FRAME = "9:1";
const SECTION = "3:1";

beforeEach(() => {
  figmaRequest.mockReset();
  figmaRequest.mockImplementation((type: string, params: Record<string, unknown>) => {
    if (type === "figma.file.outline.request") {
      return Promise.resolve({
        requestId: "r-outline",
        outline: {
          fileKey: FILE_KEY,
          name: "HDC-APP/main",
          version: VERSION,
          lastModified_ms: 1,
          editorType: "figma",
          source: "rest",
          pages: [],
        },
      });
    }
    if (type === "figma.file.nodes.request") {
      const ids = (params.ids as string[]).filter(Boolean);
      const nodes: Record<string, unknown> = {};
      for (const id of ids) {
        nodes[id] = {
          id,
          name: `Node ${id}`,
          type: id === SECTION ? "SECTION" : "FRAME",
          children: [],
        };
      }
      return Promise.resolve({
        requestId: "r-nodes",
        version: VERSION,
        source: "rest",
        nodes,
        components: {},
        styles: {},
      });
    }
    return Promise.resolve({ requestId: "r" });
  });
});

afterEach(cleanup);

const fullKey = (ids: readonly string[]) => figmaKeys.nodes(SERVER, FILE_KEY, ids, VERSION);
const shallowKey = figmaKeys.nodesShallow(SERVER, FILE_KEY, SECTION, VERSION);
const outlineKey = figmaKeys.outline(SERVER, FILE_KEY, VERSION);

/** Mirrors what the sidebar does: an expanded frame passes its id, a
 * collapsed frame passes an EMPTY id list (the FrameRow hook stays mounted). */
function FullTreeProbe({ ids }: { ids: readonly string[] }) {
  useFigmaNodes(SERVER, FILE_KEY, ids, VERSION);
  return null;
}
function ShallowProbe() {
  useFigmaSectionChildren(SERVER, FILE_KEY, SECTION, VERSION);
  return null;
}
function OutlineProbe() {
  useFigmaOutline(SERVER, FILE_KEY, VERSION);
  return null;
}

function Tree({ collapsed, showSecondary }: { collapsed: boolean; showSecondary: boolean }) {
  return (
    <>
      <FullTreeProbe ids={collapsed ? [] : [COLLAPSED_FRAME]} />
      <FullTreeProbe ids={[ACTIVE_FRAME]} />
      {showSecondary ? (
        <>
          <ShallowProbe />
          <OutlineProbe />
        </>
      ) : null}
    </>
  );
}

const fullRequestsFor = (id: string) =>
  figmaRequest.mock.calls.filter(
    ([type, params]) =>
      type === "figma.file.nodes.request" &&
      (params as { depth?: number }).depth === undefined &&
      (params as { ids: string[] }).ids.includes(id),
  );

/** Let the 0ms GC timer TanStack schedules on the last observer detach fire. */
async function runGcTick() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
}

describe("useFigmaNodes retention (spec 32.5.1)", () => {
  it("releases a collapsed frame's full subtree on the next GC tick while the still-active frame keeps its data", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <Tree collapsed={false} showSecondary />
      </QueryClientProvider>,
    );
    // Expanded frames' subtrees are fetched and observed.
    await waitFor(() => {
      expect(client.getQueryData(fullKey([COLLAPSED_FRAME]))).toBeDefined();
      expect(client.getQueryData(fullKey([ACTIVE_FRAME]))).toBeDefined();
    });
    expect(fullRequestsFor(COLLAPSED_FRAME)).toHaveLength(1);

    // Collapse the first frame (FrameRow passes ids:[]) and unmount the
    // shallow/outline probes — every one of those queries loses its last
    // observer in the SAME commit, so the contrast below is purely the
    // helpers' declared retention policy, not observation state.
    rerender(
      <QueryClientProvider client={client}>
        <Tree collapsed showSecondary={false} />
      </QueryClientProvider>,
    );
    await runGcTick();

    // The collapsed full subtree is GONE from the cache (the 5-minute default
    // would have held it outside the FrameStore LRU)…
    expect(client.getQueryCache().find({ queryKey: fullKey([COLLAPSED_FRAME]) })).toBeUndefined();
    // …while the still-expanded frame is untouched…
    expect(client.getQueryData(fullKey([ACTIVE_FRAME]))).toBeDefined();
    // …and the shallow section read and the outline keep BOTH their cache
    // entries and their data: their query policy is unchanged.
    const shallow = client.getQueryCache().find({ queryKey: shallowKey });
    expect(shallow).toBeDefined();
    expect(shallow?.state.data).toBeDefined();
    const outline = client.getQueryCache().find({ queryKey: outlineKey });
    expect(outline).toBeDefined();
    expect(outline?.state.data).toBeDefined();
  });

  it("re-expanding after a collapse asks the DAEMON again on the pinned version", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <Tree collapsed={false} showSecondary={false} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(client.getQueryData(fullKey([COLLAPSED_FRAME]))).toBeDefined());
    rerender(
      <QueryClientProvider client={client}>
        <Tree collapsed showSecondary={false} />
      </QueryClientProvider>,
    );
    await runGcTick();
    expect(client.getQueryCache().find({ queryKey: fullKey([COLLAPSED_FRAME]) })).toBeUndefined();

    // Expand again: with the entry released this can only be served by a new
    // daemon request — and it must carry the SAME pinned version the outline
    // rows were rendered from.
    rerender(
      <QueryClientProvider client={client}>
        <Tree collapsed={false} showSecondary={false} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(fullRequestsFor(COLLAPSED_FRAME)).toHaveLength(2));
    expect(fullRequestsFor(COLLAPSED_FRAME)[1][1]).toEqual({
      fileKey: FILE_KEY,
      ids: [COLLAPSED_FRAME],
      version: VERSION,
    });
    await waitFor(() => expect(client.getQueryData(fullKey([COLLAPSED_FRAME]))).toBeDefined());
  });
});
