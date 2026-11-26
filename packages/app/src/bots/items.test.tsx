/** @vitest-environment jsdom */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Bot, BotItem } from "@jagentdesk/protocol/bots/types";
import type { PendingPermission } from "@/types/shared";
import { BotItems } from "./items";

const state = vi.hoisted(() => ({
  items: [] as BotItem[],
  permissions: new Map<string, PendingPermission>(),
}));
vi.mock("./queries", () => ({
  useItems: () => ({
    data: state.items,
    isSuccess: true,
    isPending: false,
    isError: false,
    error: null,
    refetch: () => undefined,
  }),
  useBotsConnection: () => ({ client: null, connected: true, supported: true, enabled: true }),
  useBotsMutation: () => ({ mutate: () => undefined, isPending: false, error: null }),
  botsKey: (serverId: string) => ["bots", serverId],
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (select: (value: unknown) => unknown) =>
    select({
      sessions: {
        host: { agents: new Map(), pendingPermissions: state.permissions },
      },
    }),
}));
vi.mock("@/agent-stream/view", () => ({
  PermissionRequestCard: ({ permission }: { permission: PendingPermission }) => (
    <div data-testid={`card-${permission.request.id}`}>{permission.request.name}</div>
  ),
}));
vi.mock("@/utils/diff-highlighter", () => ({ parseDiff: () => [] }));
vi.mock("@/components/markdown/renderer", () => ({ MarkdownRenderer: () => null }));
vi.mock("@/components/diff-viewer", () => ({ DiffViewer: () => null }));
vi.mock("@/components/ui/scrollable-code-surface", () => ({ ScrollableCodeSurface: () => null }));
vi.mock("@/utils/tool-call-parsers", () => ({ parseUnifiedDiff: () => [] }));
vi.mock("@/utils/navigate-to-agent", () => ({ navigateToAgent: () => undefined }));
vi.mock("@/data/query", () => ({ useFetchQuery: () => ({ data: undefined }) }));
vi.mock("@/components/gumloop-shell/use-gumloop-chrome", () => ({
  useIsGumloopTheme: () => false,
}));
vi.mock("./help", () => ({
  TabHint: ({ testID }: { testID?: string }) => <div data-testid={testID} />,
}));
vi.mock("expo-router", () => ({
  router: { setParams: () => undefined, push: () => undefined },
  useLocalSearchParams: () => ({}),
}));

afterEach(() => {
  cleanup();
  state.items = [];
  state.permissions = new Map();
});

const bot: Bot = {
  id: "bot",
  slug: "heocon",
  name: "heocon",
  identity: "Worker bot",
  provider: "opencode",
  model: "opencode/big-pickle",
  modeId: "build",
  unattended: false,
  agentId: "supervisor",
  paused: false,
  schedules: [],
  lookAround: { enabled: false, intervalMinutes: 60 },
  createdAt_ms: 1,
  updatedAt_ms: 1,
} as Bot;

function pendingPermission(agentId: string, id: string): PendingPermission {
  return {
    key: `${agentId}:${id}`,
    agentId,
    request: { id, provider: "opencode", name: "external_directory", kind: "tool" },
  };
}

it("puts the bot's pending permission cards under Needs you in the Items tab", () => {
  state.items = [
    {
      id: "item",
      botId: "bot",
      title: "Fix sum",
      doneMeans: "Tests pass",
      status: "working",
      workerAgentIds: ["worker"],
      comments: [],
      reviewRounds: 0,
      reviews: [],
      createdAt_ms: 1,
      updatedAt_ms: 1,
    },
  ];
  state.permissions = new Map([
    ["worker:per_worker", pendingPermission("worker", "per_worker")],
    ["supervisor:per_supervisor", pendingPermission("supervisor", "per_supervisor")],
    ["other:per_other", pendingPermission("other", "per_other")],
  ]);
  render(<BotItems serverId="host" bot={bot} />);
  const needsYou = screen.getByTestId("bots-needs-you-permissions");
  // The test renders untranslated keys; bots.needs_you is "Needs you".
  expect(within(needsYou).getByText("bots.needs_you")).toBeTruthy();
  expect(within(needsYou).getByTestId("card-per_worker")).toBeTruthy();
  expect(within(needsYou).getByTestId("card-per_supervisor")).toBeTruthy();
  expect(screen.queryByTestId("card-per_other")).toBeNull();
});

it("shows the empty hint only when nothing needs the user", () => {
  state.permissions = new Map([
    ["supervisor:per_supervisor", pendingPermission("supervisor", "per_supervisor")],
  ]);
  const { unmount } = render(<BotItems serverId="host" bot={bot} />);
  expect(screen.queryByTestId("bot-items-empty")).toBeNull();
  unmount();
  state.permissions = new Map();
  render(<BotItems serverId="host" bot={bot} />);
  expect(screen.getByTestId("bot-items-empty")).toBeTruthy();
  expect(screen.queryByTestId("bots-needs-you-permissions")).toBeNull();
});
