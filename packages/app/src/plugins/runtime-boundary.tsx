import { QueryClientProvider } from "@tanstack/react-query";
import {
  PluginClientStateProvider,
  PluginTranslationProvider,
  type PluginClientStateSource,
  JAgentDeskApiProvider,
  PluginRpcProvider,
} from "@jagentdesk/plugin/client/host";
import { useMemo, type ReactNode } from "react";
import { createPluginClientStateSource } from "./client-state/source";
import type { InstalledPlugin } from "./types";
import { usePluginSurfaceRuntime } from "./surface-runtime";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";

export function PluginRuntimeBoundary({
  plugin,
  client,
  stateSource,
  children,
}: {
  plugin: InstalledPlugin;
  client: DaemonClient;
  stateSource?: PluginClientStateSource;
  children: ReactNode;
}) {
  const source = useMemo(
    () => stateSource ?? createPluginClientStateSource(plugin.serverId),
    [plugin.serverId, stateSource],
  );
  const runtime = usePluginSurfaceRuntime(client, plugin);
  if (!runtime) return null;
  const content = plugin.translations ? (
    <PluginTranslationProvider runtime={plugin.translations}>{children}</PluginTranslationProvider>
  ) : (
    children
  );
  return (
    <QueryClientProvider client={plugin.queryClient}>
      <JAgentDeskApiProvider jagentdesk={runtime.jagentdesk}>
        <PluginRpcProvider invoke={runtime.invoke} subscribe={runtime.subscribe}>
          <PluginClientStateProvider source={source}>{content}</PluginClientStateProvider>
        </PluginRpcProvider>
      </JAgentDeskApiProvider>
    </QueryClientProvider>
  );
}
