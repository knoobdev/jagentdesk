/** @vitest-environment jsdom */
import { createElement, type ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { usePermissionResponse, type PermissionResponder } from "./use-permission-response";

afterEach(cleanup);

function setup(respondToPermissionAndWait: PermissionResponder["respondToPermissionAndWait"]) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  const onExpired = vi.fn();
  const { result } = renderHook(
    () =>
      usePermissionResponse({
        client: { respondToPermissionAndWait },
        agentId: "agent",
        requestId: "per_external",
        unavailableMessage: "Daemon client unavailable",
        onExpired,
      }),
    { wrapper },
  );
  return { result, onExpired };
}

it("stops the spinner and shows the error when the answer fails, then retries", async () => {
  const respond = vi
    .fn<PermissionResponder["respondToPermissionAndWait"]>()
    .mockRejectedValueOnce(new Error("Request failed: OpenCode reply failed (HTTP 500)"))
    .mockResolvedValueOnce({
      agentId: "agent",
      requestId: "per_external",
      resolution: { behavior: "allow", selectedActionId: "once" },
    });
  const { result } = setup(respond);
  vi.spyOn(console, "error").mockImplementation(() => undefined);

  act(() => result.current.respond({ behavior: "allow", selectedActionId: "once" }, "once"));
  expect(result.current.respondingActionId).toBe("once");
  await waitFor(() =>
    expect(result.current.error).toBe("Request failed: OpenCode reply failed (HTTP 500)"),
  );
  expect(result.current.respondingActionId).toBeNull();
  expect(result.current.isResponding).toBe(false);

  act(() => result.current.respond({ behavior: "allow", selectedActionId: "once" }, "once"));
  await waitFor(() => expect(result.current.isResponding).toBe(false));
  expect(result.current.error).toBeNull();
  expect(respond).toHaveBeenCalledTimes(2);
});

it("reports a request the provider no longer has", async () => {
  const { result, onExpired } = setup(async () => ({
    agentId: "agent",
    requestId: "per_external",
    resolution: { behavior: "deny", message: "This request is no longer pending" },
    expired: true,
  }));

  act(() => result.current.respond({ behavior: "deny", selectedActionId: "reject" }, "reject"));
  await waitFor(() => expect(onExpired).toHaveBeenCalledTimes(1));
  expect(result.current.error).toBeNull();
  expect(result.current.respondingActionId).toBeNull();
});
