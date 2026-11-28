import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { AgentStreamEventPayload, SessionLedger } from "@jagentdesk/protocol/messages";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { act, Component, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { PortalProvider } from "@gorhom/portal";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { CommandCenterProvider } from "@/command-center/provider";
import { HorizontalScrollProvider } from "@/contexts/horizontal-scroll-context";
import { SidebarCalloutProvider } from "@/contexts/sidebar-callout-context";
import { ToastProvider } from "@/contexts/toast-context";
import { i18n } from "@/i18n/i18next";
import { KeyboardShiftProvider } from "@/keyboard/shift";
import { MobilePanelsProvider } from "@/mobile-panels/provider";
import { getHostRuntimeStore, type HostRuntimeSnapshot } from "@/runtime/host-runtime";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { TimelineRowSheetProvider } from "@/components/timeline-row-sheet";
import { RegroundingRow } from "@/continuity/regrounding-row";
import { applyStreamEvent, type StreamItem } from "@/types/stream";
import { WindowChromeProvider } from "@/utils/desktop-window";
import { WindowLayoutProvider } from "@/window-layout";

const SERVER_ID = "row-modal-server";
const AGENT_ID = "row-modal-agent";
const REGROUNDING_ID = "regrounding-1";
const BLOCK_HEADING = "Current goal (recorded by you)";
const START = new Date("2026-11-28T09:00:00.000Z").getTime();

const LEDGER: SessionLedger = {
  markdown: "",
  goal: null,
  decisions: [],
  openItems: [],
  nextStep: null,
  handoffs: [],
  providerSessions: [],
  compactions: [],
  regroundings: [
    {
      id: REGROUNDING_ID,
      at: new Date(START).toISOString(),
      compactionId: "compaction-1",
      text: [
        "<jagentdesk-where-we-are>",
        "Your context was just compacted.",
        "",
        `## ${BLOCK_HEADING}`,
        "",
        "Fix the flickering modal.",
        "</jagentdesk-where-we-are>",
      ].join("\n"),
      estimatedTokens: 2987,
    },
  ],
};

const ledgerRequests = { count: 0 };

/** Answers anything the panel asks a daemon client with an inert value, so nothing throws. */
const inert: unknown = new Proxy(function inertFunction() {}, {
  get: (_target, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : inert),
  apply: () => inert,
});

// The daemon answers the ledger request after a network-like delay. The host stays "connecting",
// so the panel does not start its own fetches; only the ledger hook reads this client.
const ledgerClient = new Proxy(
  {
    getAgentLedger: async (agentId: string) => {
      ledgerRequests.count += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { requestId: "ledger", agentId, ledger: LEDGER, error: null };
    },
  },
  {
    get: (target, prop) => {
      if (prop === "getAgentLedger") return target.getAgentLedger;
      return prop === "then" ? undefined : inert;
    },
  },
) as unknown as DaemonClient;

function hostSnapshot(): HostRuntimeSnapshot {
  return {
    serverId: SERVER_ID,
    activeConnectionId: null,
    activeConnection: null,
    connectionStatus: "connecting",
    client: ledgerClient,
    lastError: null,
    lastOnlineAt: null,
    agentDirectoryStatus: "idle",
    agentDirectoryError: null,
    hasEverLoadedAgentDirectory: true,
    probeByConnectionId: new Map(),
    clientGeneration: 1,
    connectionEpoch: 1,
    pendingPairingRequests: [],
    pendingPairingRequest: null,
    localRetriesExhausted: false,
  };
}

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

function agentAt(updatedAtMs: number): Agent {
  const at = new Date(updatedAtMs);
  return {
    serverId: SERVER_ID,
    id: AGENT_ID,
    provider: "mock",
    status: "running",
    activeTurn: null,
    createdAt: new Date(START),
    updatedAt: at,
    lastUserMessageAt: null,
    lastActivityAt: at,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    runtimeInfo: undefined,
    lastUsage: undefined,
    lastError: null,
    title: "Re-grounded agent",
    cwd: "/tmp/row-modal-project",
    model: null,
    controls: undefined,
    thinkingOptionId: undefined,
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: null,
    parentAgentId: null,
    labels: {},
    projectPlacement: null,
  };
}

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error ? (
      <span data-testid="boundary-error">{this.state.error.message}</span>
    ) : (
      this.props.children
    );
  }
}

const queryClient = new QueryClient();
const noop = () => {};

/** The providers the app root puts around every screen (see embedded-agent-pane.browser.test). */
function AppRoot({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <WindowLayoutProvider>
        <WindowChromeProvider>
          <KeyboardProvider>
            <KeyboardShiftProvider>
              <AppRuntime>{children}</AppRuntime>
            </KeyboardShiftProvider>
          </KeyboardProvider>
        </WindowChromeProvider>
      </WindowLayoutProvider>
    </QueryClientProvider>
  );
}

function AppRuntime({ children }: { children: ReactNode }) {
  return (
    <SidebarCalloutProvider>
      <ToastProvider>
        <CommandCenterProvider>
          <MobilePanelsProvider>
            <HorizontalScrollProvider>
              <PortalProvider>{children}</PortalProvider>
            </HorizontalScrollProvider>
          </MobilePanelsProvider>
        </CommandCenterProvider>
      </ToastProvider>
    </SidebarCalloutProvider>
  );
}

let container: HTMLDivElement;
let root: Root;
let tail: StreamItem[] = [];
let head: StreamItem[] = [];
let clock = START;

/** Runs one daemon stream event through the real reducer into the session store. */
function applyEvent(event: AgentStreamEventPayload): void {
  clock += 50;
  const result = applyStreamEvent({ tail, head, event, timestamp: new Date(clock) });
  tail = result.tail;
  head = result.head;
  useSessionStore.getState().setAgentStreamState(SERVER_ID, AGENT_ID, { tail, head });
}

function timeline(item: Record<string, unknown>): AgentStreamEventPayload {
  return { type: "timeline", provider: "mock", item } as unknown as AgentStreamEventPayload;
}

function toolCall(index: number): AgentStreamEventPayload {
  return timeline({
    type: "tool_call",
    callId: `call-${index}`,
    name: "Bash",
    status: "completed",
    error: null,
    detail: { type: "shell", command: `echo step-${index}`, output: `step-${index}` },
  });
}

beforeEach(async () => {
  await page.viewport(1440, 900);
  await i18n.changeLanguage("en");
  container = document.createElement("div");
  container.style.width = "1440px";
  container.style.height = "900px";
  document.body.appendChild(container);
  root = createRoot(container);
  tail = [];
  head = [];
  clock = START;
  ledgerRequests.count = 0;
  queryClient.clear();
  const store = getHostRuntimeStore();
  const snapshot = hostSnapshot();
  const original = store.getSnapshot.bind(store);
  vi.spyOn(store, "getSnapshot").mockImplementation((serverId) =>
    serverId === SERVER_ID ? snapshot : original(serverId),
  );
  useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
  useSessionStore.getState().setAgents(SERVER_ID, new Map([[AGENT_ID, agentAt(START)]]));
  useSessionStore.getState().markAgentHistorySynchronized(SERVER_ID, AGENT_ID);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useSessionStore.getState().clearSession(SERVER_ID);
  vi.restoreAllMocks();
});

async function renderConversation(): Promise<void> {
  const { AgentConversationPanel, EmbeddedAgentPaneProvider } =
    await import("@/plugins/builtin/host-api");
  await act(async () => {
    root.render(
      <AppRoot>
        <Boundary>
          <EmbeddedAgentPaneProvider
            serverId={SERVER_ID}
            workspaceId={null}
            agentId={AGENT_ID}
            tabId={`test-dock-${AGENT_ID}`}
            onClose={noop}
          >
            <AgentConversationPanel />
          </EmbeddedAgentPaneProvider>
        </Boundary>
      </AppRoot>,
    );
  });
  await settle(100);
}

async function settle(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

interface Frame {
  /** The sheet's card is in the document. */
  open: boolean;
  /** The block's markdown is in the card (not "Loading…"). */
  block: boolean;
  /** The card's height, rounded: a collapse to a one-line card is a visible jump. */
  height: number;
}

function sampleFrame(): Frame {
  const sheet = document.querySelector('[data-testid="regrounding-sheet"] [role="dialog"]');
  const text = sheet?.textContent ?? "";
  return {
    open: sheet !== null,
    block: text.includes(BLOCK_HEADING),
    height: Math.round(sheet?.getBoundingClientRect().height ?? 0),
  };
}

function transitions(frames: Frame[], key: "open" | "block"): number {
  let count = 0;
  for (let index = 1; index < frames.length; index += 1) {
    if (frames[index]![key] !== frames[index - 1]![key]) count += 1;
  }
  return count;
}

interface StreamSummary {
  frames: number;
  openTransitions: number;
  blockTransitions: number;
  heights: number[];
  ledgerRequests: number;
  rowMounted: boolean;
  last: Frame;
}

/** Opens "View block", then streams `chunks` assistant text + tool call pairs, sampling frames. */
async function streamWithBlockOpen(chunks: number): Promise<StreamSummary> {
  // History before the notice, then the notice the first turn after a compaction appends.
  for (let index = 0; index < 8; index += 1) applyEvent(toolCall(index));
  applyEvent(
    timeline({
      type: "notification",
      level: "info",
      message: "Re-grounded after compaction",
      regrounding: { id: REGROUNDING_ID, compactionId: "compaction-1", estimatedTokens: 2987 },
    }),
  );
  // The user's next message starts a new turn; the agent streams that turn below the notice.
  applyEvent(timeline({ type: "user_message", text: "Keep going", messageId: "user-2" }));
  await renderConversation();
  expect(container.querySelector('[data-testid="boundary-error"]')?.textContent ?? null).toBe(null);

  const viewBlock = container.querySelector<HTMLElement>('[data-testid="regrounding-view-block"]');
  expect(viewBlock).not.toBeNull();
  await act(async () => {
    viewBlock!.click();
  });
  await settle(200);
  expect(sampleFrame()).toMatchObject({ open: true, block: true });

  // The agent streams: every chunk is new rows and an agent update with a newer `updatedAt`, as
  // the daemon's `touchUpdatedAt` stamps every live event.
  const frames: Frame[] = [sampleFrame()];
  for (let chunk = 0; chunk < chunks; chunk += 1) {
    await act(async () => {
      applyEvent(
        timeline({ type: "assistant_message", text: `Step ${chunk}: reading the next file. ` }),
      );
      applyEvent(toolCall(100 + chunk));
      useSessionStore.getState().setAgents(SERVER_ID, new Map([[AGENT_ID, agentAt(clock)]]));
    });
    for (let frame = 0; frame < 2; frame += 1) {
      await act(async () => {
        await nextFrame();
      });
      frames.push(sampleFrame());
    }
  }
  await settle(200);
  frames.push(sampleFrame());

  const summary: StreamSummary = {
    frames: frames.length,
    openTransitions: transitions(frames, "open"),
    blockTransitions: transitions(frames, "block"),
    heights: [...new Set(frames.map((frame) => frame.height))],
    ledgerRequests: ledgerRequests.count,
    rowMounted: container.querySelector('[data-testid="regrounding-row"]') !== null,
    last: frames.at(-1)!,
  };
  console.log(`row-modal-steady ${JSON.stringify(summary)}`);
  return summary;
}

it("keeps the re-grounding block open and steady while the agent streams", async () => {
  const summary = await streamWithBlockOpen(140);
  expect(summary.openTransitions).toBe(0);
  expect(summary.blockTransitions).toBe(0);
  expect(summary.heights).toHaveLength(1);
  // The block is fetched once per open, not once per agent update.
  expect(summary.ledgerRequests).toBe(1);
  expect(summary.last).toMatchObject({ open: true, block: true });
}, 120_000);

const NOTICE = { id: REGROUNDING_ID, compactionId: "compaction-1", estimatedTokens: 2987 };

/** A list cell that its list unmounts, as LegendList does past its draw distance on phones. */
function RowCell({ mounted }: { mounted: boolean }) {
  return (
    <TimelineRowSheetProvider>
      {mounted ? (
        <RegroundingRow
          serverId={SERVER_ID}
          agentId={AGENT_ID}
          message="Re-grounded after compaction"
          timestamp={START}
          notice={NOTICE}
        />
      ) : null}
    </TimelineRowSheetProvider>
  );
}

it("keeps the block open after its row unmounts, until the user closes it", async () => {
  const renderCell = (mounted: boolean) =>
    act(async () => {
      root.render(
        <AppRoot>
          <RowCell mounted={mounted} />
        </AppRoot>,
      );
    });
  await renderCell(true);
  await act(async () => {
    container.querySelector<HTMLElement>('[data-testid="regrounding-view-block"]')!.click();
  });
  await settle(200);
  expect(sampleFrame()).toMatchObject({ open: true, block: true });

  // The agent's answer grows past the draw distance: the list unmounts the notice row.
  await renderCell(false);
  await settle(200);
  expect(container.querySelector('[data-testid="regrounding-row"]')).toBeNull();
  expect(sampleFrame()).toMatchObject({ open: true, block: true });

  // Only the user closes it.
  const close = document.querySelector<HTMLElement>(
    '[data-testid="regrounding-sheet"] [aria-label="Close"]',
  );
  expect(close).not.toBeNull();
  await act(async () => {
    close!.click();
  });
  await settle(400);
  expect(sampleFrame().open).toBe(false);
});
