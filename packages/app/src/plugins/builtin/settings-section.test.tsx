/** @vitest-environment jsdom */
import React from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/data/query-client";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  BUILTIN_PLUGIN_MANIFESTS,
  type BuiltinPluginListItem,
} from "@jagentdesk/protocol/builtin-plugins";
import { i18n } from "@/i18n/i18next";
import { BuiltinPluginsSection } from "./settings-section";

void i18n;
const state = vi.hoisted(() => ({
  supported: true,
  connected: true,
  isLoading: false,
  isError: false,
  error: new Error("Host offline"),
  data: { canManage: true, plugins: [] as BuiltinPluginListItem[] },
  set: vi.fn(),
  refetch: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("./hooks", () => ({ useBuiltinPlugins: () => state }));
vi.mock("@/utils/confirm-dialog", () => ({
  confirmDialog: (...args: unknown[]) => state.confirm(...args),
}));
// Reanimated's native runtime has no JS DOM implementation; retain the actual Switch interaction.
vi.mock("react-native-reanimated", () => ({
  default: { View: "div" },
  Keyframe: class {
    duration() {
      return this;
    }
  },
  Easing: { ease: "ease", inOut: (value: unknown) => value },
  interpolateColor: (_: unknown, _input: unknown, colors: string[]) => colors[0],
  useAnimatedStyle: (fn: () => unknown) => fn(),
  useDerivedValue: (fn: () => unknown) => ({ value: fn() }),
  withTiming: (value: unknown) => value,
}));
beforeEach(() => {
  state.data = {
    canManage: true,
    plugins: BUILTIN_PLUGIN_MANIFESTS.map((entry) =>
      Object.assign({}, entry, {
        requires: [...entry.requires],
        enabled: entry.defaultEnabled,
        available: true,
      }),
    ),
  };
  state.set.mockReset().mockResolvedValue(undefined);
  state.confirm.mockReset().mockResolvedValue(true);
});
afterEach(cleanup);
it("renders all 35 names, defaults, descriptions and dependencies", () => {
  render(
    <QueryClientProvider client={queryClient}>
      <BuiltinPluginsSection serverId="host" />
    </QueryClientProvider>,
  );
  expect(screen.getAllByRole("switch")).toHaveLength(35);
  expect(
    screen
      .getAllByRole("switch")
      .filter((element) => element.getAttribute("aria-checked") === "true"),
  ).toHaveLength(29);
  expect(screen.getByText(/Requires SSH servers/).textContent).toContain(
    "Run and monitor tasks on SSH servers.",
  );
});
it("asks about dependents, and declining leaves the host unchanged", async () => {
  state.confirm.mockResolvedValue(false);
  render(
    <QueryClientProvider client={queryClient}>
      <BuiltinPluginsSection serverId="host" />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("switch", { name: "SSH servers" }));
  await waitFor(() =>
    expect(state.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Also turn off Remote tasks?" }),
    ),
  );
  expect(state.set).toHaveBeenCalledTimes(0);
});
it("accepting the dependency dialog sends a cascade", async () => {
  render(
    <QueryClientProvider client={queryClient}>
      <BuiltinPluginsSection serverId="host" />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("switch", { name: "SSH servers" }));
  await waitFor(() => expect(state.set).toHaveBeenCalledWith("ssh-servers", false, true));
});
it("shows an actionable error and permits retry after a failed toggle", async () => {
  state.set.mockRejectedValueOnce(new Error("Host disconnected"));
  render(
    <QueryClientProvider client={queryClient}>
      <BuiltinPluginsSection serverId="host" />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("switch", { name: "Docker" }));
  expect((await screen.findByText("Host disconnected")).textContent).toBe("Host disconnected");
  fireEvent.click(screen.getByRole("switch", { name: "Docker" }));
  await waitFor(() => expect(state.set).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByText("Host disconnected")).toBe(null));
});
it("disables unavailable and read-only controls", () => {
  state.data.canManage = false;
  state.data.plugins[0] = {
    ...state.data.plugins[0]!,
    available: false,
    unavailableReason: "Install Docker",
  };
  render(
    <QueryClientProvider client={queryClient}>
      <BuiltinPluginsSection serverId="host" />
    </QueryClientProvider>,
  );
  expect(screen.getByText(/Install Docker/).textContent).toContain("Install Docker");
  fireEvent.click(screen.getByRole("switch", { name: "Docker" }));
  expect(state.set).toHaveBeenCalledTimes(0);
});

vi.mock("@gorhom/bottom-sheet", async () => {
  const { ScrollView, TextInput } =
    await vi.importActual<typeof import("react-native")>("react-native");
  const shared = await import("../../../test-stubs/gorhom-bottom-sheet");
  return {
    ...shared,
    BottomSheetBackdrop: () => null,
    BottomSheetModal: () => null,
    BottomSheetScrollView: ScrollView,
    BottomSheetTextInput: TextInput,
    useBottomSheetInternal: () => null,
  };
});
