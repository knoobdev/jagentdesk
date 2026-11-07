/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import type {
  FigmaInteraction,
  FigmaNode,
  FigmaOutline,
} from "@jagentdesk/protocol/figma/rpc-schemas";
import type { FigmaFileRef } from "@/figma/contracts";

const { theme, clientRef, featureRef, callFigma, staged } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 1.5: 6, 2: 8, 3: 12, 4: 16, 6: 24 },
    fontSize: { xs: 11, sm: 13, base: 15 },
    fontWeight: { normal: "400", semibold: "600" },
    borderRadius: { sm: 4, md: 6, lg: 8, full: 9999 },
    borderWidth: { 1: 1 },
    colors: {
      surface0: "#111",
      surface1: "#161616",
      surfaceWorkspace: "#0a0a0a",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#333",
      accent: "#2563eb",
    },
  },
  clientRef: { current: { id: "client" } as unknown },
  featureRef: { current: true },
  callFigma: vi.fn(),
  staged: [] as string[],
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  withUnistyles: (component: unknown) => component,
  useUnistyles: () => ({ theme }),
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => clientRef.current,
  // The REAL page-outline module (no longer mocked here) loads with the player and needs these.
  useHostRuntimeConnectionStatus: () => "connected",
  getHostRuntimeStore: () => ({ getSnapshot: () => ({ client: clientRef.current }) }),
}));
vi.mock("@/runtime/host-features", () => ({
  useHostFeature: () => featureRef.current,
}));
vi.mock("./figma-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./figma-api")>()),
  callFigma,
}));
vi.mock("@/utils/open-external-url", () => ({ openExternalUrl: vi.fn() }));
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
      { type: "button", onClick: () => (disabled ? undefined : onPress?.()) },
      children,
    ),
}));
vi.mock("@/components/ui/loading-spinner", () => ({
  LoadingSpinner: () => React.createElement("div", { "data-spinner": true }),
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children?: React.ReactNode }) => children,
  DropdownMenuTrigger: ({ children, testID }: Record<string, unknown>) =>
    React.createElement(
      "div",
      { "data-testid": (testID as string | undefined) ?? "figma-flow-trigger" },
      children as React.ReactNode,
    ),
  DropdownMenuContent: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children?: React.ReactNode;
    onSelect?: () => void;
  }) => React.createElement("button", { type: "button", onClick: () => onSelect?.() }, children),
}));
vi.mock("@/components/ui/switch", () => ({
  Switch: () => React.createElement("input", { type: "checkbox" }),
}));
// The stage is the pixel side of the contract (W7/W9): record which frames it is asked to draw
// and hand renderOverlay its space so the player's REAL hotspot layer stays under test.
vi.mock("./frame-stage", () => ({
  FrameStage: (props: Record<string, unknown>) => {
    const root = props.root as FigmaNode | undefined;
    if (root) staged.push(root.id);
    const space = {
      scale: 1,
      boxOf: (node: FigmaNode) => node.absoluteBoundingBox ?? null,
    };
    return React.createElement(
      "div",
      { "data-testid": "figma-frame-stage", "data-frame": root?.id ?? "" },
      typeof props.renderOverlay === "function"
        ? (props.renderOverlay as (s: unknown) => React.ReactNode)(space)
        : null,
    );
  },
}));

import { PrototypePlayer } from "./prototype-player";
import { assetScopeKey, peekAssetScope } from "./asset-store";
import { node, outline, page, summary } from "./test-support/frames";

// Player loading + memory scope (spec 32.5.3, ADR-0037): the transition clock never finishes
// before the target's data lands, the AFTER_TIMEOUT arms only when its data arrives after
// navigation, playback pins the outline version, errors keep both Retry and Close available,
// and a file/version swap under an open player resets navigation and re-requests.

const file = { serverId: "s1", fileKey: "fk1" };

function buildFrame(id: string, children: FigmaNode[] = []): FigmaNode {
  return node({ id, name: `Frame ${id}`, width: 300, height: 400, color: [1, 1, 1, 1], children });
}

const CLICK_TO_1_2: FigmaInteraction = {
  nodeId: "1:1a",
  trigger: { type: "ON_CLICK" },
  action: {
    type: "NODE",
    navigation: "NAVIGATE",
    destinationId: "1:2",
    transition: { type: "DISSOLVE", durationMs: 100 },
  },
} as unknown as FigmaInteraction;

const TIMEOUT_TO_1_3: FigmaInteraction = {
  nodeId: "1:2",
  trigger: { type: "AFTER_TIMEOUT", delayMs: 200 },
  action: {
    type: "NODE",
    navigation: "NAVIGATE",
    destinationId: "1:3",
    transition: { type: "DISSOLVE", durationMs: 100 },
  },
} as unknown as FigmaInteraction;

const FRAMES: Record<string, FigmaNode> = {
  "1:1": buildFrame("1:1", [
    node({
      id: "1:1a",
      name: "Go to second",
      type: "RECTANGLE",
      x: 10,
      y: 10,
      width: 80,
      height: 40,
    }),
  ]),
  "1:2": buildFrame("1:2"),
  "1:3": buildFrame("1:3"),
};

function meta(interactions: FigmaInteraction[]) {
  return {
    flows: [],
    interactions,
    overlays: [],
    overlaySettingsAvailable: true,
  };
}

const outlineFixture: FigmaOutline = outline([
  page({
    id: "p1",
    name: "Page",
    flowStartingPoints: [{ nodeId: "1:1", name: "Onboarding" }],
  }),
]);

/** playback responses keyed by the exact sorted id set; unkeyed sets answer immediately. */
interface PlaybackControl {
  hold(key: string): void;
  release(key: string, value: unknown): void;
  requests: Array<{ frameIds: string[]; version: string }>;
}

let playback: PlaybackControl & { settle(): void };

function installPlayback(): void {
  const pending = new Map<string, { promise: Promise<unknown>; resolve: (v: unknown) => void }>();
  const deferred = new Map<string, (value: unknown) => void>();
  const requests: Array<{ frameIds: string[]; version: string }> = [];
  playback = {
    requests,
    hold(key: string) {
      pending.set(
        key,
        pending.get(key) ?? {
          promise: new Promise((resolve) => deferred.set(key, resolve)),
          resolve: () => undefined,
        },
      );
    },
    release(key: string, value: unknown) {
      deferred.get(key)?.(value);
      pending.delete(key);
    },
    settle() {
      for (const [, d] of deferred) d({ frames: {}, prototype: null });
    },
  };
  callFigma.mockImplementation(async (_client: unknown, type: string, params: unknown) => {
    if (type !== "figma.file.playback.request") return { frames: {}, prototype: null };
    const { frameIds, version } = params as { frameIds: string[]; version: string };
    requests.push({ frameIds, version });
    const key = [...frameIds].sort().join(",");
    const held = pending.get(key);
    if (held) await held.promise;
    return {
      frames: Object.fromEntries(frameIds.map((id) => [id, FRAMES[id]]).filter(([, n]) => n)),
      // AFTER_TIMEOUT only rides responses that include the timed frame (arrives after the
      // first navigation), so the "arms when data arrives" path is the real one.
      prototype: frameIds.includes("1:2")
        ? meta([CLICK_TO_1_2, TIMEOUT_TO_1_3])
        : meta([CLICK_TO_1_2]),
    };
  });
}

let queryClient: QueryClient;
let container: HTMLDivElement;
let root: Root;

function renderPlayer(props?: {
  file?: FigmaFileRef;
  outline?: FigmaOutline;
  startNodeId?: string | null;
}) {
  const onClose = vi.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <PrototypePlayer
          file={props?.file ?? file}
          outline={props?.outline ?? outlineFixture}
          startNodeId={props?.startNodeId ?? null}
          onClose={onClose}
        />
      </QueryClientProvider>,
    );
  });
  return { onClose };
}

function rerenderPlayer(props: { file?: FigmaFileRef; outline?: FigmaOutline }) {
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <PrototypePlayer
          file={props.file ?? file}
          outline={props.outline ?? outlineFixture}
          startNodeId={null}
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );
  });
}

function text(): string {
  return container.textContent ?? "";
}

function stateTestId(): string | null {
  return (
    container.querySelector("[data-testid^='figma-player-state-']")?.getAttribute("data-testid") ??
    null
  );
}

function clickHotspot(name: string) {
  const el = container.querySelector(`[aria-label="${name}"]`) as HTMLElement | null;
  expect(el, `hotspot "${name}"`).not.toBeNull();
  act(() => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const heldKey = (...ids: string[]) => [...ids].sort().join(",");

// Module-level so test callbacks stay within the nesting budget while still reading true.
function framesFor(ids: string[]): Record<string, FigmaNode> {
  return Object.fromEntries(ids.map((id) => [id, FRAMES[id]]).filter(([, n]) => n));
}
function requestedIdSets(): string[] {
  return playback.requests.map((r) => r.frameIds.join(","));
}
function requestedOnce(version: string, ids: string): boolean {
  return playback.requests.some((r) => r.version === version && r.frameIds.join(",") === ids);
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  clientRef.current = { id: "client" };
  featureRef.current = true;
  callFigma.mockReset();
  staged.length = 0;
  installPlayback();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
  playback.settle();
});

describe("PrototypePlayer capability gate", () => {
  it("a host without scoped playback never sends a playback request", async () => {
    featureRef.current = false;
    const { onClose } = renderPlayer();
    expect(text()).toContain(
      "Update this host to use prototype playback without loading the whole file.",
    );
    expect(callFigma).not.toHaveBeenCalled();
    clickButton("Close");
    expect(onClose).toHaveBeenCalled();
  });
});

function clickButton(label: string) {
  const el = [...container.querySelectorAll("button")].find(
    (b) => (b.textContent ?? "").trim() === label,
  ) as HTMLElement | undefined;
  expect(el, `button "${label}"`).toBeTruthy();
  act(() => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("PrototypePlayer scoped playback", () => {
  it("auto-starts the first flow pinned to the outline version, via the scoped RPC only", async () => {
    const { onClose } = renderPlayer();
    await waitFor(() => expect(staged).toContain("1:1"));
    for (const request of playback.requests) expect(request.version).toBe("v1");
    // Scoped playback only: never the full prototype RPC.
    expect(new Set(callFigma.mock.calls.map(([, type]) => type))).toEqual(
      new Set(["figma.file.playback.request"]),
    );
    clickButton("Close");
    expect(onClose).toHaveBeenCalled();
  });

  it("starts on the deep-linked node when one is given", async () => {
    renderPlayer({ startNodeId: "1:2" });
    await waitFor(() => expect(staged).toContain("1:2"));
    expect(playback.requests[0]?.frameIds).toEqual(["1:2"]);
    // The deep-linked frame's own AFTER_TIMEOUT still arms from its response data: 1:3 lands
    // without any click, on the timer the frame carries. The dissolve must then settle to idle.
    await waitFor(() => expect(staged).toContain("1:3"), { timeout: 4000 });
    await waitFor(() => expect(stateTestId()).toBe("figma-player-state-idle"), { timeout: 4000 });
  });

  it("click navigation requests the pair as its own bounded batch", async () => {
    renderPlayer();
    await waitFor(() => expect(staged).toContain("1:1"));
    clickHotspot("Go to second");
    await waitFor(() => expect(requestedIdSets()).toContain("1:1,1:2"));
    for (const request of playback.requests)
      expect(request.frameIds.length).toBeLessThanOrEqual(10);
  });

  it("the transition clock never completes before the target data arrives, and the timer arms when it does", async () => {
    playback.hold(heldKey("1:1", "1:2"));
    renderPlayer();
    await waitFor(() => expect(staged).toContain("1:1"));
    clickHotspot("Go to second");
    await waitFor(() => expect(stateTestId()).toBe("figma-player-state-transition"));

    // Past duration (100) and past the AFTER_TIMEOUT delay (200): with the target still loading
    // the clock must be parked on the transition — no early complete, no starved re-arm.
    await sleep(450);
    expect(stateTestId()).toBe("figma-player-state-transition");
    expect(staged).not.toContain("1:3");

    playback.release(heldKey("1:1", "1:2"), {
      frames: { "1:1": FRAMES["1:1"], "1:2": FRAMES["1:2"] },
      prototype: meta([CLICK_TO_1_2, TIMEOUT_TO_1_3]),
    });
    // Pair on hand → the animation runs and completes → 1:2 is the frame on stage.
    await waitFor(() => expect(stateTestId()).toBe("figma-player-state-idle"), { timeout: 4000 });
    await waitFor(() => expect(staged).toContain("1:2"));
    expect(staged).not.toContain("1:3");

    // Now the timer the data carries may fire: 1:3 arrives only after that, by itself.
    await waitFor(() => expect(staged).toContain("1:3"), { timeout: 4000 });
    expect(requestedIdSets()).toContain(heldKey("1:2", "1:3"));
  });

  it("surfaces a failed batch with Retry AND Close, and recovers when retry succeeds", async () => {
    let fail = true;
    callFigma.mockImplementation(async (_client: unknown, type: string, params: unknown) => {
      const { frameIds } = params as { frameIds: string[] };
      if (type === "figma.file.playback.request" && fail) throw new Error("Playback failed");
      return {
        frames: framesFor(frameIds),
        prototype: frameIds.includes("1:2")
          ? meta([CLICK_TO_1_2, TIMEOUT_TO_1_3])
          : meta([CLICK_TO_1_2]),
      };
    });
    const first = renderPlayer();
    await waitFor(() =>
      expect(container.querySelector("[data-testid='figma-player-error']")).not.toBeNull(),
    );
    expect(text()).toContain("Playback failed");
    // Close always works, error or not.
    clickButton("Close");
    expect(first.onClose).toHaveBeenCalled();

    // Retry on the SAME error view re-issues the request; with the host healthy again the
    // frame paints and the error view is gone.
    fail = false;
    clickButton("Retry");
    await waitFor(() => expect(staged).toContain("1:1"));
    expect(container.querySelector("[data-testid='figma-player-error']")).toBeNull();
  });

  it("a file/version change resets navigation, re-pins playback, and retires the old asset scope", async () => {
    renderPlayer();
    await waitFor(() => expect(staged).toContain("1:1"));
    expect(peekAssetScope(assetScopeKey("s1", "fk1", "v1"))).toBeDefined();

    rerenderPlayer({ file: { ...file, version: "v9" } });
    // The player restarted on the new snapshot: it re-pins playback to v9 AND restarts on the
    // flow start point, so the v1 visit's navigation state was cleared, not carried over.
    await waitFor(() => expect(requestedOnce("v9", "1:1")).toBe(true));
    const v1requests = playback.requests.filter((r) => r.version === "v1").length;
    expect(
      playback.requests
        .slice(v1requests)
        .every((r) => r.version === "v9" && r.frameIds.length <= 10),
    ).toBe(true);
    // Isolation rule: the superseded snapshot releases its decoded bytes and global font CSS.
    expect(peekAssetScope(assetScopeKey("s1", "fk1", "v1"))).toBeUndefined();
    expect(peekAssetScope(assetScopeKey("s1", "fk1", "v9"))).toBeDefined();

    act(() => root.unmount());
    expect(peekAssetScope(assetScopeKey("s1", "fk1", "v9"))).toBeUndefined();
    expect(peekAssetScope(assetScopeKey("s1", "fk1", "v1"))).toBeUndefined();
  });

  it("a deep-linked Section plays the frame inside it, never the section subtree", async () => {
    FRAMES["7:2"] = buildFrame("7:2");
    const sectionOutline = outline([
      page({
        id: "p1",
        name: "P",
        flowStartingPoints: [{ nodeId: "7:2", name: "Welcome flow" }],
        frames: [
          summary({ id: "7:1", name: "Onboarding", type: "SECTION" }),
          summary({ id: "7:2", name: "Welcome", parentId: "7:1" }),
        ],
      }),
    ]);
    renderPlayer({ outline: sectionOutline, startNodeId: "7:1" });
    await waitFor(() => expect(staged).toContain("7:2"));
    // ADR-0039: the section id never reaches playback — only the resolved frame's subtree does.
    expect(playback.requests.every((r) => !r.frameIds.includes("7:1"))).toBe(true);
  });

  it("asks for a frame when the deep-linked Section holds nothing playable", async () => {
    const sectionOutline = outline([
      page({
        id: "p1",
        name: "P",
        frames: [summary({ id: "8:1", name: "Vault", type: "SECTION", childrenLoaded: false })],
      }),
    ]);
    const view = renderPlayer({ outline: sectionOutline, startNodeId: "8:1" });
    await waitFor(() =>
      expect(container.querySelector("[data-testid='figma-player-select-frame']")).not.toBeNull(),
    );
    expect(text()).toContain('"Vault" is a section with no playable frame');
    // Nothing playable → nothing requested: the whole-section load never happens.
    expect(playback.requests).toHaveLength(0);
    clickButton("Close");
    expect(view.onClose).toHaveBeenCalled();
  });

  it("closing the player releases its asset scope", async () => {
    renderPlayer();
    await waitFor(() => expect(staged).toContain("1:1"));
    const scopeKey = assetScopeKey("s1", "fk1", "v1");
    const store = peekAssetScope(scopeKey);
    expect(store).toBeDefined();
    act(() => root.unmount());
    expect(peekAssetScope(scopeKey)).toBeUndefined();
    expect(store?.disposed).toBe(true);
  });
});
