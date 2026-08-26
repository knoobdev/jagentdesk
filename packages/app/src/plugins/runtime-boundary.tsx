import { QueryClientProvider } from "@tanstack/react-query";
import { JAgentDeskApiProvider, PluginRpcProvider } from "@jagentdesk/plugin/host";
import type { ReactNode } from "react";
import type { InstalledPlugin } from "./types";
import type { PluginSurfaceRuntime } from "./surface-runtime";

export function PluginRuntimeBoundary({
  plugin,
  runtime,
  children,
}: {
  plugin: InstalledPlugin;
  runtime: PluginSurfaceRuntime;
  children: ReactNode;
}) {
  return (
    <QueryClientProvider client={plugin.queryClient}>
      <JAgentDeskApiProvider jagentdesk={runtime.jagentdesk}>
        <PluginRpcProvider invoke={runtime.invoke}>{children}</PluginRpcProvider>
      </JAgentDeskApiProvider>
    </QueryClientProvider>
  );
}
