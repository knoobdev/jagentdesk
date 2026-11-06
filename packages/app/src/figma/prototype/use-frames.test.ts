/**
 * @vitest-environment jsdom
 */
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FigmaPrototype } from "@jagentdesk/protocol/figma/rpc-schemas";

const { callFigma, clientRef } = vi.hoisted(() => ({
  callFigma: vi.fn(),
  clientRef: { current: { id: "client" } as unknown },
}));

vi.mock("./figma-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./figma-api")>()),
  callFigma,
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => clientRef.current,
}));

import { figmaKeys } from "./figma-api";
import { useFigmaFrames } from "./use-frames";
import { node } from "./test-support/frames";

// ADR-0037: the player observes only what is on stage, batches stay ≤10, unobserved subtree
// data is released immediately, and revisits go back to the daemon's versioned cache. These
// tests run against a REAL QueryClient so gcTime/observer behavior is the real one.

const file = { serverId: "s1", fileKey: "fk1" };
const VERSION = "137:0";

function framesOf(ids: readonly string[]) {
  return Object.fromEntries(ids.map((id) => [id, node({ id, name: `Frame ${id}` })]));
}

function success(ids: readonly string[], prototype: FigmaPrototype | null = null) {
  return { frames: framesOf(ids), prototype };
}

let queryClient: QueryClient;

// Module-level so the batch builder's `map` stays outside the describe/it/waitFor callback
// nesting budget. v1 answers with prototype metadata; v2 (REST-only) answers without it.
async function versionedResponse(
  _client: unknown,
  _type: string,
  params: { frameIds: string[]; version: string; fileKey: string },
) {
  return {
    frames: Object.fromEntries(
      params.frameIds.map((id) => [id, node({ id, name: `${params.version}:${id}` })]),
    ),
    prototype:
      params.version === "v1"
        ? {
            flows: [],
            interactions: [
              {
                nodeId: "1:1",
                trigger: { type: "ON_CLICK" },
                action: { type: "BACK" },
              },
            ],
            overlays: [],
            overlaySettingsAvailable: true,
          }
        : null,
  };
}

function Wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(QueryClientProvider, { client: queryClient }, children);
}

function renderLookup(ids: readonly string[]) {
  const wrapper = Wrapper;
  return renderHook(() => useFigmaFrames(file, ids, VERSION), { wrapper });
}

beforeEach(() => {
  callFigma.mockReset();
  clientRef.current = { id: "client" };
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

describe("useFigmaFrames scoped playback", () => {
  it("requests figma.file.playback.request in batches of at most 10 with the pinned version", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `10:${i}`);
    callFigma.mockImplementation(async (_client, _type, params: { frameIds: string[] }) =>
      success(params.frameIds),
    );
    const view = renderLookup(ids);
    await waitFor(() => expect(view.result.current.loading).toBe(false));

    const calls = callFigma.mock.calls;
    expect(calls).toHaveLength(2);
    for (const [client, type, params] of calls) {
      expect(client).toBeTruthy();
      expect(type).toBe("figma.file.playback.request");
      expect(params).toMatchObject({ fileKey: "fk1", version: VERSION });
      expect((params.frameIds as string[]).length).toBeLessThanOrEqual(10);
    }
    const requested = calls.flatMap(([, , params]) => params.frameIds as string[]);
    expect([...requested].sort()).toEqual([...ids].sort());
    view.unmount();
  });

  it("never asks for the full prototype document", async () => {
    callFigma.mockImplementation(async (_client, _type, params: { frameIds: string[] }) =>
      success(params.frameIds),
    );
    const view = renderLookup(["1:1"]);
    await waitFor(() => expect(view.result.current.nodeFor("1:1")).not.toBeNull());
    expect(callFigma.mock.calls.map(([, type]) => type)).toEqual(["figma.file.playback.request"]);
    view.unmount();
  });

  it("keeps lookup identities stable across re-renders so timers and callbacks are not starved", async () => {
    callFigma.mockImplementation(async (_client, _type, params: { frameIds: string[] }) =>
      success(params.frameIds),
    );
    const view = renderLookup(["1:1"]);
    await waitFor(() => expect(view.result.current.nodeFor("1:1")).not.toBeNull());
    const first = view.result.current;
    view.rerender();
    view.rerender();
    expect(view.result.current.nodeFor).toBe(first.nodeFor);
    expect(view.result.current.prototype).toBe(first.prototype);
    view.unmount();
  });

  it("merges interaction metadata and flags missing overlay settings", async () => {
    const interactions = [
      {
        nodeId: "1:1",
        trigger: { type: "ON_CLICK" as const },
        action: { type: "NODE" as const, navigation: "NAVIGATE" as const, destinationId: "2:1" },
      },
    ];
    const meta: FigmaPrototype = {
      flows: [{ nodeId: "1:1", name: "Flow", pageId: "p1" }],
      interactions,
      overlays: [{ frameId: "2:1", position: "BOTTOM_CENTER" }],
      overlaySettingsAvailable: true,
    };
    callFigma.mockImplementation(async (_client, _type, params: { frameIds: string[] }) =>
      success(params.frameIds, meta),
    );
    const view = renderLookup(["1:1"]);
    await waitFor(() => expect(view.result.current.prototype).not.toBeNull());
    const merged = view.result.current.prototype!;
    // Flows ride the outline, never the playback merge.
    expect(merged.flows).toEqual([]);
    expect(merged.interactions).toEqual(interactions);
    expect(merged.overlays).toEqual(meta.overlays);
    expect(merged.overlaySettingsAvailable).toBe(true);

    // A response without prototype metadata (REST-only file) marks settings as missing.
    callFigma.mockImplementation(async (_client, _type, params: { frameIds: string[] }) =>
      success(params.frameIds, null),
    );
    const offline = renderLookup(["3:1"]);
    await waitFor(() => expect(offline.result.current.prototype).not.toBeNull());
    expect(offline.result.current.prototype!.overlaySettingsAvailable).toBe(false);
    view.unmount();
    offline.unmount();
  });

  it("deduplicates interactions carried by two batches", async () => {
    const interaction = {
      nodeId: "1:1",
      trigger: { type: "ON_CLICK" as const },
      action: { type: "BACK" as const },
    };
    const meta: FigmaPrototype = {
      flows: [],
      interactions: [interaction],
      overlays: [],
      overlaySettingsAvailable: true,
    };
    callFigma.mockImplementation(async (_client, _type, params: { frameIds: string[] }) =>
      success(params.frameIds, meta),
    );
    const ids = Array.from({ length: 12 }, (_, i) => `10:${i}`);
    const view = renderLookup(ids);
    await waitFor(() => expect(view.result.current.prototype).not.toBeNull());
    expect(view.result.current.prototype!.interactions).toHaveLength(1);
    view.unmount();
  });

  it("releases subtree data for frames that leave the stage, and re-reads the daemon on revisit", async () => {
    callFigma.mockImplementation(async (_client, _type, params: { frameIds: string[] }) =>
      success(params.frameIds),
    );
    const view = renderLookup(["1:1"]);
    await waitFor(() => expect(view.result.current.nodeFor("1:1")).not.toBeNull());
    const keyA = [...figmaKeys.file(file.serverId, file.fileKey, VERSION), "playback", "1:1"];
    expect(queryClient.getQueryCache().find({ queryKey: keyA })).toBeTruthy();

    // Only the new frame is observed; the old subtree is GC'd immediately (gcTime 0).
    view.unmount();
    const revisit = renderLookup(["2:1"]);
    await waitFor(() => expect(revisit.result.current.nodeFor("2:1")).not.toBeNull());
    await waitFor(() =>
      expect(queryClient.getQueryCache().find({ queryKey: keyA })).toBeUndefined(),
    );

    // Going Back reads the daemon's versioned cache again — no REST-side retention here.
    const back = renderLookup(["1:1"]);
    await waitFor(() => expect(back.result.current.nodeFor("1:1")).not.toBeNull());
    expect(callFigma).toHaveBeenCalledTimes(3);
    revisit.unmount();
    back.unmount();
  });

  it("surfaces batch errors and refetches on retry", async () => {
    let fail = true;
    callFigma.mockImplementation(async (_client, _type, params: { frameIds: string[] }) => {
      if (fail) throw new Error("Figma said no.");
      return success(params.frameIds);
    });
    const view = renderLookup(["1:1"]);
    await waitFor(() => expect(view.result.current.error).toBe("Figma said no."));
    expect(view.result.current.loading).toBe(false);
    fail = false;
    view.result.current.retry();
    await waitFor(() => expect(view.result.current.nodeFor("1:1")).not.toBeNull());
    expect(view.result.current.error).toBeNull();
    view.unmount();
  });

  it("reports an offline host instead of an endless spinner", async () => {
    clientRef.current = null;
    const view = renderLookup(["1:1"]);
    expect(view.result.current.loading).toBe(false);
    expect(view.result.current.error).toBe("The host is offline.");
    expect(callFigma).not.toHaveBeenCalled();
    view.unmount();
  });

  it("is quiet with nothing on stage: no requests, no error, no loading", () => {
    const view = renderLookup([]);
    expect(callFigma).not.toHaveBeenCalled();
    expect(view.result.current.loading).toBe(false);
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.prototype).toBeNull();
    view.unmount();
  });
});

// Regression (parent review): the derived merge used to memoize on dataUpdatedAt/error alone.
// Equal timestamps across different requests — or a payload swapped under the same observer —
// could keep the PREVIOUS request's nodes, interactions, and prototype alive. These pin the
// lookup to the actual identity of each batch's request and data.
describe("useFigmaFrames derived-merge identity", () => {
  const T = 1_700_000_000_000;

  function playbackKey(ids: readonly string[], version = VERSION, fileKey = "fk1") {
    return [...figmaKeys.file("s1", fileKey, version), "playback", [...ids].sort().join(",")];
  }

  beforeEach(() => {
    callFigma.mockReset();
    clientRef.current = { id: "client" };
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(Date, "now").mockReturnValue(T);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rebuilds when a second id set is already cached at the same timestamp", async () => {
    const state = { ids: ["1:1"] as string[] };
    callFigma.mockImplementation(async (_client, _type, params: { frameIds: string[] }) =>
      success(params.frameIds),
    );
    const view = renderHook(() => useFigmaFrames(file, state.ids, VERSION), {
      wrapper: Wrapper,
    });
    await waitFor(() => expect(view.result.current.nodeFor("1:1")).not.toBeNull());

    // The revisit's query is served from cache — same dataUpdatedAt as the first batch had.
    queryClient.setQueryData(playbackKey(["2:1"]), success(["2:1"]));
    state.ids = ["2:1"];
    view.rerender();
    await waitFor(() => expect(view.result.current.nodeFor("2:1")).not.toBeNull());
    // The previous request's nodes cannot survive into the new id set.
    expect(view.result.current.nodeFor("1:1")).toBeNull();
    view.unmount();
  });

  it("rebuilds when the same batch's data is replaced within one millisecond", async () => {
    const state = { ids: ["1:1"] as string[] };
    callFigma.mockImplementation(async (_client, _type, params: { frameIds: string[] }) =>
      success(params.frameIds),
    );
    const view = renderHook(() => useFigmaFrames(file, state.ids, VERSION), { wrapper: Wrapper });
    await waitFor(() => expect(view.result.current.nodeFor("1:1")?.name).toBe("Frame 1:1"));

    queryClient.setQueryData(playbackKey(["1:1"]), {
      frames: { "1:1": node({ id: "1:1", name: "Renamed" }) },
      prototype: null,
    });
    view.rerender();
    // Date.now is pinned: the replacement carries the SAME dataUpdatedAt, and only the data
    // identity tells the two payloads apart.
    await waitFor(() => expect(view.result.current.nodeFor("1:1")?.name).toBe("Renamed"));
    view.unmount();
  });

  it("never carries nodes or interactions across a file/version switch", async () => {
    callFigma.mockImplementation(versionedResponse);
    const state = { ids: ["1:1"] as string[], version: "v1", fileKey: "fk1" };
    const view = renderHook(
      () => useFigmaFrames({ serverId: "s1", fileKey: state.fileKey }, state.ids, state.version),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(view.result.current.nodeFor("1:1")?.name).toBe("v1:1:1"));
    expect(view.result.current.prototype?.interactions).toHaveLength(1);

    // The new snapshot's batch is cached at the SAME timestamp as the old one resolved.
    queryClient.setQueryData(playbackKey(["1:1"], "v2"), {
      frames: { "1:1": node({ id: "1:1", name: "v2:1:1" }) },
      prototype: null,
    });
    state.version = "v2";
    view.rerender();
    await waitFor(() => expect(view.result.current.nodeFor("1:1")?.name).toBe("v2:1:1"));
    // v1's prototype metadata (and its overlay-availability verdict) must not survive: a null
    // v2 prototype marks settings unavailable and carries no interactions.
    await waitFor(() => expect(view.result.current.prototype?.interactions).toEqual([]));
    expect(view.result.current.prototype?.overlaySettingsAvailable).toBe(false);
    view.unmount();
  });

  it("separates two servers by key even at identical timestamps", async () => {
    const ids = ["1:1"];
    callFigma.mockImplementation(async (_client, _type, params: { frameIds: string[] }) =>
      success(params.frameIds),
    );
    const view = renderLookup(ids);
    await waitFor(() => expect(view.result.current.nodeFor("1:1")).not.toBeNull());
    const first = view.result.current.nodeFor;
    view.unmount();

    // A different server never sees s1's cache entry, so it asks for its own playback data.
    const other = renderHook(
      () => useFigmaFrames({ serverId: "s2", fileKey: "fk1" }, ids, VERSION),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(other.result.current.nodeFor("1:1")).not.toBeNull());
    expect(other.result.current.nodeFor).not.toBe(first);
    expect(callFigma).toHaveBeenCalledTimes(2);
    other.unmount();
  });
});
