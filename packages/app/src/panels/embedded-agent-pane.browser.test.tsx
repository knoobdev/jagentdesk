import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { act, Component, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PortalProvider } from "@gorhom/portal";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { CommandCenterProvider } from "@/command-center/provider";
import { HorizontalScrollProvider } from "@/contexts/horizontal-scroll-context";
import { SidebarCalloutProvider } from "@/contexts/sidebar-callout-context";
import { ToastProvider } from "@/contexts/toast-context";
import { KeyboardShiftProvider } from "@/keyboard/shift";
import { MobilePanelsProvider } from "@/mobile-panels/provider";
import { WindowChromeProvider } from "@/utils/desktop-window";
import { WindowLayoutProvider } from "@/window-layout";
import { agentPanelRegistration } from "@/panels/agent-panel";
import { useSessionStore, type Agent } from "@/stores/session-store";

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

const SERVER_ID = "embedded-pane-server";
const AGENT_ID = "embedded-agent";
const TIMESTAMP = new Date("2026-11-27T09:00:00.000Z");

const AGENT: Agent = {
  serverId: SERVER_ID,
  id: AGENT_ID,
  provider: "claude",
  status: "idle",
  activeTurn: null,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  lastUserMessageAt: null,
  lastActivityAt: TIMESTAMP,
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
  title: "Simulator chat",
  cwd: "/tmp/embedded-project",
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

/**
 * The providers the app root (root-app.tsx, app/_layout.tsx) puts around every screen, plugin
 * screens included. Nothing here comes from a workspace.
 */
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

const queryClient = new QueryClient();
const noop = () => {};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
  useSessionStore.getState().setAgents(SERVER_ID, new Map([[AGENT_ID, AGENT]]));
  // The daemon has delivered this agent's history, as for a fleet chat reopened from the dock.
  useSessionStore.getState().markAgentHistorySynchronized(SERVER_ID, AGENT_ID);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useSessionStore.getState().clearSession(SERVER_ID);
});

async function renderEmbedded(workspaceId: string | null): Promise<void> {
  // Plugins reach the app through host-api; loaded after the panel modules so its plugin import
  // cycle resolves in app order.
  const { AgentConversationPanel, EmbeddedAgentPaneProvider } =
    await import("@/plugins/builtin/host-api");
  // The panel plugins get is the one workspaces register for agent tabs.
  expect(AgentConversationPanel).toBe(agentPanelRegistration.component);
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await act(async () => {
      root.render(
        <AppRoot>
          <Boundary>
            <EmbeddedAgentPaneProvider
              serverId={SERVER_ID}
              workspaceId={workspaceId}
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
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  } finally {
    consoleError.mockRestore();
  }
}

function boundaryError(): string | null {
  return container.querySelector('[data-testid="boundary-error"]')?.textContent ?? null;
}

// A plugin chat dock (Devices, Data, Clusters, Workbench, Jira, Forge) shows an existing agent
// on a screen with no workspace around it. The panel must render from the host-api provider alone.
it("renders an existing agent's conversation outside a workspace", async () => {
  await renderEmbedded(null);

  expect(boundaryError()).toBe(null);
  expect(container.querySelector('[data-testid="agent-loading"]')).toBeNull();
  expect(container.querySelector('[data-testid="message-input-root"]')).not.toBeNull();
});

it("lists the agent's subagents without workspace sheets", async () => {
  const child: Agent = {
    ...AGENT,
    id: "embedded-child",
    title: "Child",
    workspaceId: "embedded-workspace",
    parentAgentId: AGENT_ID,
    labels: { "jagentdesk.parent-agent-id": AGENT_ID },
  };
  useSessionStore.getState().setAgents(
    SERVER_ID,
    new Map([
      [AGENT_ID, { ...AGENT, workspaceId: "embedded-workspace" }],
      [child.id, child],
    ]),
  );

  await renderEmbedded("embedded-workspace");

  expect(boundaryError()).toBe(null);
  expect(container.querySelector('[data-testid="subagents-track-header"]')).not.toBeNull();
});
