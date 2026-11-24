/** @vitest-environment jsdom */
import { createElement, type ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BotsPush } from "@jagentdesk/protocol/bots/rpc-schemas";
import { useBotsPushes, useBots, useBotsMutation, botsKey } from "./queries";
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
it("invalidates the lazy Supervisor binding after bots.changed without invalidating home files", () => {
  const key = [...botsKey("host"), "list"];
  queryClient.setQueryData(key, [{ id: "bot" }]);
  const fileKey = [...botsKey("host"), "home-file", "/home", "SOUL.md"];
  queryClient.setQueryData(fileKey, "editor base");
  renderHook(() => useBotsPushes("host"), { wrapper: Wrapper });
  act(() =>
    state.listeners.get("bots.changed")?.({ type: "bots.changed", payload: { botId: "bot" } }),
  );
  expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
  expect(queryClient.getQueryState(fileKey)?.isInvalidated).toBe(false);
});
it("deduplicates chat pushes and releases subscriptions on unmount", () => {
  const message = {
    id: "m",
    botId: "b",
    role: "assistant" as const,
    text: "Ready",
    source: "chat",
    createdAt_ms: 1,
  };
  queryClient.setQueryData([...botsKey("host"), "chat", "b"], [message]);
  const { unmount } = renderHook(() => useBotsPushes("host"), { wrapper: Wrapper });
  act(() =>
    state.listeners.get("bots.chat.message")?.({ type: "bots.chat.message", payload: { message } }),
  );
  expect(queryClient.getQueryData([...botsKey("host"), "chat", "b"])).toEqual([message]);
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
