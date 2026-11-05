/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { FigmaPendingOp } from "@jagentdesk/protocol/figma/rpc-schemas";
import type { FigmaFileRef } from "@/figma/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PendingBar } from "./pending-bar";

// The pending bar (spec 32.6.1) against a fake daemon seam: counts and gating come from the
// queue, Apply waits for a linked file and conflict choices, removals hit the right RPC, and the
// figma.pending.changed push refetches instead of polling.

function op(overrides: Partial<FigmaPendingOp> & { id: string }): FigmaPendingOp {
  return {
    op: { op: "rename", nodeId: "1:2", name: "Hero" },
    baseVersion: "v1",
    previous: {},
    createdAt_ms: 1,
    origin: "user",
    state: "pending",
    ...overrides,
  };
}

const OPS: FigmaPendingOp[] = [
  op({ id: "fpo_1" }),
  op({ id: "fpo_2", op: { op: "delete", nodeId: "1:3" }, origin: "agent" }),
];

const figmaRequest = vi.fn();
let pushHandlers: Array<(message: { type: string; fileKey: string; count: number }) => void> = [];

// primitives imports expo-clipboard, whose build ships untranspilable JSX.
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => undefined) }));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () =>
    ({
      figmaRequest,
      onFigmaPush: (_type: string, handler: (message: never) => void) => {
        pushHandlers.push(handler as never);
        return () => {
          pushHandlers = pushHandlers.filter((candidate) => candidate !== handler);
        };
      },
    }) as never,
}));

function linkStatus(paired: boolean) {
  return {
    requestId: "r",
    error: null,
    status: {
      server: "listening",
      port: 8766,
      pluginInstalled: true,
      pluginVersion: "1.0.0",
      manifestPath: null,
      runScriptEnabled: true,
      files: paired
        ? [
            {
              fileKey: "filekey123456",
              fileName: "Landing",
              pageName: null,
              paired: true,
              pluginVersion: "1.0.0",
              connectedAt_ms: 1,
            },
          ]
        : [],
      pendingPairing: null,
    },
  };
}

function respond(type: string, params: Record<string, unknown>) {
  if (type === "figma.pending.list.request") return { requestId: "r", error: null, ops: OPS };
  if (type === "figma.link.status.request") return linkStatus(params?.paired !== false);
  return { requestId: "r", error: null };
}

const FILE: FigmaFileRef = { serverId: "srv", fileKey: "filekey123456" };

function listCalls(): number {
  return figmaRequest.mock.calls.filter(([type]) => type === "figma.pending.list.request").length;
}

function renderBar() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <PendingBar file={FILE} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  pushHandlers = [];
  figmaRequest.mockImplementation(async (type: string, params: Record<string, unknown>) =>
    respond(type, params),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PendingBar", () => {
  it("shows the queue count and hides when empty", async () => {
    renderBar();
    const count = await screen.findByTestId("figma-pending-count");
    expect(count.textContent).toContain("2 pending changes");
    figmaRequest.mockImplementation(async (type: string) =>
      type === "figma.pending.list.request"
        ? { requestId: "r", error: null, ops: [] }
        : { requestId: "r", error: null, status: null },
    );
    cleanup();
    renderBar();
    await waitFor(() => expect(figmaRequest).toHaveBeenCalled());
    expect(screen.queryByTestId("figma-pending-bar")).toBeNull();
  });

  it("gates Apply on the file being linked", async () => {
    figmaRequest.mockImplementation(async (type: string) =>
      type === "figma.pending.list.request"
        ? { requestId: "r", error: null, ops: OPS }
        : {
            ...linkStatus(false),
          },
    );
    renderBar();
    const apply = await screen.findByTestId("figma-pending-apply");
    expect(apply.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByTestId("figma-pending-unlinked-hint")).toBeDefined();
  });

  it("removes a single op through figma.pending.remove", async () => {
    renderBar();
    fireEvent.click(await screen.findByTestId("figma-pending-review"));
    fireEvent.click(await screen.findByTestId("figma-pending-remove-fpo_1"));
    await waitFor(() =>
      expect(figmaRequest).toHaveBeenCalledWith("figma.pending.remove.request", {
        fileKey: "filekey123456",
        opId: "fpo_1",
      }),
    );
  });

  it("discards the queue through figma.pending.discard", async () => {
    renderBar();
    fireEvent.click(await screen.findByTestId("figma-pending-discard"));
    await waitFor(() =>
      expect(figmaRequest).toHaveBeenCalledWith("figma.pending.discard.request", {
        fileKey: "filekey123456",
      }),
    );
  });

  it("applies with resolutions once every conflict has a choice", async () => {
    figmaRequest.mockImplementation(async (type: string) =>
      type === "figma.pending.list.request"
        ? { requestId: "r", error: null, ops: [op({ id: "fpo_c", state: "conflict" })] }
        : linkStatus(true),
    );
    renderBar();
    fireEvent.click(await screen.findByTestId("figma-pending-review"));
    const apply = await screen.findByTestId("figma-pending-apply");
    expect(apply.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByTestId("figma-pending-keep-mine-fpo_c"));
    fireEvent.click(apply);
    await waitFor(() =>
      expect(figmaRequest).toHaveBeenCalledWith("figma.pending.apply.request", {
        fileKey: "filekey123456",
        resolutions: { fpo_c: "keep_mine" },
      }),
    );
  });

  it("refetches the queue on figma.pending.changed pushes", async () => {
    renderBar();
    await screen.findByTestId("figma-pending-count");
    const callsBefore = listCalls();
    await waitFor(() => expect(pushHandlers.length).toBeGreaterThan(0));
    fireEvent.click(screen.getByTestId("figma-pending-review"));
    pushHandlers[0]?.({ type: "figma.pending.changed", fileKey: "filekey123456", count: 2 });
    await waitFor(() => expect(listCalls()).toBeGreaterThan(callsBefore));
  });

  it("ignores pushes for other files", async () => {
    renderBar();
    await screen.findByTestId("figma-pending-count");
    const callsBefore = listCalls();
    await waitFor(() => expect(pushHandlers.length).toBeGreaterThan(0));
    pushHandlers[0]?.({ type: "figma.pending.changed", fileKey: "otherfile12345", count: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(listCalls()).toBe(callsBefore);
  });
});
