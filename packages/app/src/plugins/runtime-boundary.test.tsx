import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { PluginWorkspaceSnapshot } from "@jagentdesk/plugin";
import type { PluginClientStateSource } from "@jagentdesk/plugin/client/host";
import { useWorkspace } from "@jagentdesk/plugin/client";
import { QueryClient } from "@tanstack/react-query";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { PluginRuntimeBoundary } from "./runtime-boundary";
import type { InstalledPlugin } from "./types";

vi.mock("./surface-runtime", () => ({
  usePluginSurfaceRuntime: () => ({ jagentdesk: {}, invoke: vi.fn(), subscribe: vi.fn() }),
}));
vi.mock("./client-state/source", () => ({
  createPluginClientStateSource: (serverId: string) => ({
    subscribe: () => () => {},
    getWorkspace: () => ({ id: serverId }),
    getAgent: () => null,
  }),
}));

const plugin = { serverId: "installation-host", queryClient: new QueryClient() } as InstalledPlugin;
const client = {} as DaemonClient;

function Surface() {
  return <span>{useWorkspace("workspace", (workspace) => workspace.id)}</span>;
}

it("gives screens and settings a state source scoped to their installation host", () => {
  expect(
    renderToStaticMarkup(
      <PluginRuntimeBoundary plugin={plugin} client={client}>
        <Surface />
      </PluginRuntimeBoundary>,
    ),
  ).toBe("<span>installation-host</span>");
});

const source: PluginClientStateSource = {
  subscribe: () => () => {},
  getWorkspace: () => ({ id: "another-host" }) as PluginWorkspaceSnapshot,
  getAgent: () => null,
};

it("preserves a surface's cross-host state source", () => {
  expect(
    renderToStaticMarkup(
      <PluginRuntimeBoundary plugin={plugin} client={client} stateSource={source}>
        <Surface />
      </PluginRuntimeBoundary>,
    ),
  ).toBe("<span>another-host</span>");
});
