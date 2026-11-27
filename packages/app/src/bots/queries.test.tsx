/** @vitest-environment jsdom */
import { createElement, type ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BotsPush } from "@jagentdesk/protocol/bots/rpc-schemas";
import { useBotsPushes, useBots, useBotsMutation, botsReadKey } from "./queries";
const state = vi.hoisted(() => ({
  connected: true,
  supported: true,
  request: vi.fn(),
  listeners: new Map<string, (message: BotsPush) => void>(),
}));
const client = {
  botsRequest: state.request,
  onBotsPush: (type: string, listener: (message: BotsPush) => void) => {
    state.listeners.set(type, listener);
    return () => {
      state.listeners.delete(type);
    };
  },
};
vi.mock("@/runtime/host-features", () => ({ useHostFeature: () => state.supported }));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeIsConnected: () => state.connected,
  useHostRuntimeClient: () => client,
}));
let queryClient: QueryClient;
function Wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}
beforeEach(() => {
  state.connected = true;
  state.supported = true;
  state.request.mockReset();
  state.listeners.clear();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});
it("does not request Bots when the host feature is off", () => {
  state.supported = false;
  const { result } = renderHook(() => useBots("host"), { wrapper: Wrapper });
  expect(result.current.fetchStatus).toBe("idle");
  expect(state.request).not.toHaveBeenCalled();
});
it("refetches the bot list and that bot's chat tree on bots.changed, not other bots' reads", () => {
  const list = botsReadKey("host", "bots.list.request", {});
  const tree = botsReadKey("host", "bots.chats.tree.request", { botId: "bot" });
  const otherTree = botsReadKey("host", "bots.chats.tree.request", { botId: "other" });
  const soul = botsReadKey("host", "bots.home_file.read.request", {
    botId: "bot",
    file: "SOUL.md",
  });
  for (const key of [list, tree, otherTree, soul]) queryClient.setQueryData(key, {});
  renderHook(() => useBotsPushes("host"), { wrapper: Wrapper });
  act(() =>
    state.listeners.get("bots.changed")?.({ type: "bots.changed", payload: { botId: "bot" } }),
  );
  expect(queryClient.getQueryState(list)?.isInvalidated).toBe(true);
  expect(queryClient.getQueryState(tree)?.isInvalidated).toBe(true);
  expect(queryClient.getQueryState(otherTree)?.isInvalidated).toBe(false);
  expect(queryClient.getQueryState(soul)?.isInvalidated).toBe(false);
});
it("refetches only the reads an activity push names", () => {
  const needs = botsReadKey("host", "bots.needs_you.list.request", { botId: "b" });
  const automations = botsReadKey("host", "bots.automations.list.request", { botId: "b" });
  queryClient.setQueryData(needs, { rows: [] });
  queryClient.setQueryData(automations, { automations: [], total: 0 });
  renderHook(() => useBotsPushes("host"), { wrapper: Wrapper });
  act(() =>
    state.listeners.get("bots.activity_changed")?.({
      type: "bots.activity_changed",
      payload: { botId: "b", parts: ["needs_you"] },
    }),
  );
  expect(queryClient.getQueryState(needs)?.isInvalidated).toBe(true);
  expect(queryClient.getQueryState(automations)?.isInvalidated).toBe(false);
});
it("replaces a chat line by id (a running note that finished) and releases subscriptions", () => {
  const message = {
    id: "m",
    botId: "b",
    role: "system" as const,
    text: "Looking around",
    source: "look_around",
    createdAt_ms: 1,
  };
  const key = botsReadKey("host", "bots.chat.history.request", { botId: "b", limit: 200 });
  queryClient.setQueryData(key, { messages: [message] });
  const { unmount } = renderHook(() => useBotsPushes("host"), { wrapper: Wrapper });
  const done = { ...message, text: "Looked around · 2 suggestions", updatedAt_ms: 2 };
  act(() =>
    state.listeners.get("bots.chat.message")?.({
      type: "bots.chat.message",
      payload: { message: done },
    }),
  );
  expect(queryClient.getQueryData(key)).toEqual({ messages: [done] });
  unmount();
  expect(state.listeners.size).toBe(0);
});
it("surfaces a rejected write and allows a successful retry", async () => {
  state.request.mockRejectedValueOnce(new Error("Host disconnected")).mockResolvedValueOnce({});
  const { result } = renderHook(() => useBotsMutation("host", "bots.pause.request"), {
    wrapper: Wrapper,
  });
  await act(async () => {
    await expect(result.current.mutateAsync({ botId: "b", paused: true })).rejects.toThrow(
      "Host disconnected",
    );
  });
  await waitFor(() => expect(result.current.error?.message).toBe("Host disconnected"));
  await act(async () => {
    await result.current.mutateAsync({ botId: "b", paused: true });
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
});
