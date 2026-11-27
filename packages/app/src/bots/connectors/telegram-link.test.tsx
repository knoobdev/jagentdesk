/** @vitest-environment jsdom */
import { createElement, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import type { BotsPush, TelegramStatus } from "@jagentdesk/protocol/bots/rpc-schemas";
import { I18nextProvider } from "react-i18next";
import { i18n } from "@/i18n/i18next";
import { useBotsPushes } from "@/bots/queries";
import { BotConnectorSetupDialog } from "./setup-dialogs";
import { telegramDeepLink, telegramLinkView } from "./telegram-link";

const state = vi.hoisted(() => ({
  status: null as unknown as TelegramStatus,
  opened: [] as string[],
  listeners: new Map<string, (message: BotsPush) => void>(),
}));
const client = {
  botsRequest: vi.fn(async (type: string) => {
    if (type === "bots.telegram.status.request") return { status: state.status };
    if (type === "bots.telegram.link_code.request")
      return { code: "479290", expiresAt_ms: Date.now() + 600_000 };
    throw new Error(`unexpected ${type}`);
  }),
  onBotsPush: (type: string, listener: (message: BotsPush) => void) => {
    state.listeners.set(type, listener);
    return () => {
      state.listeners.delete(type);
    };
  },
};
vi.mock("@/runtime/host-features", () => ({ useHostFeature: () => true }));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeIsConnected: () => true,
  useHostRuntimeClient: () => client,
}));
vi.mock("@/utils/open-external-url", () => ({
  openExternalUrl: async (url: string) => {
    state.opened.push(url);
  },
}));
vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({ visible, children }: { visible: boolean; children: ReactNode }) =>
    visible ? createElement("div", null, children) : null,
}));

const bot = { id: "bot-1", name: "Scout" } as Bot;
let queryClient: QueryClient;
function Screen() {
  useBotsPushes("host");
  return createElement(BotConnectorSetupDialog, {
    serverId: "host",
    bot,
    connector: "telegram",
    onClose: () => undefined,
  });
}
beforeEach(() => {
  state.status = {
    connected: true,
    relayConnected: true,
    botUsername: "scout_jad_bot",
    allowedUsers: [],
  };
  state.opened = [];
  state.listeners.clear();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});

it("Link my Telegram account shows Open in Telegram, the code to send, and turns into Linked on the push", async () => {
  render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(QueryClientProvider, { client: queryClient }, createElement(Screen)),
    ),
  );
  fireEvent.click(await screen.findByText("Link my Telegram account"));
  const open = await screen.findByText("Open in Telegram");
  expect(screen.getByText("Or send this code to @scout_jad_bot:")).toBeTruthy();
  expect(screen.getByTestId("bot-telegram-link-code").textContent).toBe("479290");
  expect(screen.getByText(/^Expires at /)).toBeTruthy();
  fireEvent.click(open);
  await waitFor(() => expect(state.opened).toEqual(["https://t.me/scout_jad_bot?start=479290"]));

  // The owner taps Start in Telegram; the daemon links them and pushes bots.changed.
  const dana = { id: "42", name: "Dana", username: "dana" };
  state.status = { ...state.status, allowedUsers: [dana], linked: { code: "479290", user: dana } };
  act(() =>
    state.listeners.get("bots.changed")?.({ type: "bots.changed", payload: { botId: bot.id } }),
  );
  expect(await screen.findByText("Linked · Dana")).toBeTruthy();
  expect(screen.queryByText("Open in Telegram")).toBeNull();
  expect(screen.queryByTestId("bot-telegram-link-code")).toBeNull();
});

it("a code is pending until it expires or the status names who sent it", () => {
  const code = { code: "123456", expiresAt_ms: 2_000 };
  const status = { botUsername: "scout_jad_bot", linked: undefined };
  expect(telegramLinkView(null, status, 1_000)).toEqual({ kind: "none" });
  expect(telegramLinkView(code, status, 1_000)).toEqual({
    kind: "pending",
    code: "123456",
    expiresAt_ms: 2_000,
    username: "scout_jad_bot",
    url: "https://t.me/scout_jad_bot?start=123456",
  });
  expect(telegramLinkView(code, status, 2_000)).toEqual({ kind: "none" });
  const user = { id: "42", name: "Dana" };
  expect(telegramLinkView(code, { ...status, linked: { code: "123456", user } }, 5_000)).toEqual({
    kind: "linked",
    name: "Dana",
  });
  // An earlier link does not count for a new code.
  expect(telegramLinkView(code, { ...status, linked: { code: "000001", user } }, 1_000).kind).toBe(
    "pending",
  );
  expect(telegramDeepLink("a_b", "000123")).toBe("https://t.me/a_b?start=000123");
});
