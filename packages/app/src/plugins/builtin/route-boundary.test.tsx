/** @vitest-environment jsdom */
import React from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/data/query-client";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import { BuiltinPluginScreenBoundary, builtinPluginScreenLayout } from "./route-boundary";
import { HostRouteProvider } from "@/navigation/host-route-context";

void i18n;
const state = vi.hoisted(() => ({
  enabled: false,
  data: {
    canManage: true,
    plugins: [{ id: "docker", name: "Docker", enabled: false, available: true, requires: [] }],
  },
  set: vi.fn(),
  connected: true,
  isError: false,
}));
vi.mock("./hooks", () => ({
  useBuiltinPluginEnabled: () => state.enabled,
  useBuiltinPlugins: () => state,
}));
beforeEach(() => {
  state.enabled = false;
  state.data.canManage = true;
  state.set.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);
it("shows the disabled screen and lets an owner turn it on", async () => {
  render(
    <BuiltinPluginScreenBoundary serverId="host" id="docker">
      <span>Docker screen</span>
    </BuiltinPluginScreenBoundary>,
    { wrapper },
  );
  expect(screen.queryByText("Docker screen")).toBe(null);
  expect(screen.getByText("Plugin turned off").textContent).toBe("Plugin turned off");
  fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
  await waitFor(() => expect(state.set).toHaveBeenCalledWith("docker", true, false));
});
it("hides Turn on for a session without daemon.manage", () => {
  state.data.canManage = false;
  render(
    <BuiltinPluginScreenBoundary serverId="host" id="docker">
      <span>Docker screen</span>
    </BuiltinPluginScreenBoundary>,
    { wrapper },
  );
  expect(screen.queryByRole("button", { name: "Turn on" })).toBe(null);
});
it("retains an actionable error when enabling fails", async () => {
  state.set.mockRejectedValueOnce(new Error("Host disconnected"));
  render(
    <BuiltinPluginScreenBoundary serverId="host" id="docker">
      <span>Docker screen</span>
    </BuiltinPluginScreenBoundary>,
    { wrapper },
  );
  fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
  expect((await screen.findByText("Host disconnected")).textContent).toBe("Host disconnected");
});
it("gates a feature leaf without replacing the host navigator or core screen content", () => {
  const { rerender } = render(
    <HostRouteProvider serverId="host">
      {builtinPluginScreenLayout({
        route: { name: "docker" },
        children: <span>Docker screen</span>,
      })}
    </HostRouteProvider>,
    { wrapper },
  );
  expect(screen.queryByText("Docker screen")).toBe(null);
  rerender(
    <HostRouteProvider serverId="host">
      {builtinPluginScreenLayout({
        route: { name: "workspace/[workspaceId]/index" },
        children: <span>Workspace screen</span>,
      })}
    </HostRouteProvider>,
  );
  expect(screen.getByText("Workspace screen").textContent).toBe("Workspace screen");
});
