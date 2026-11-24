import type { ReactNode } from "react";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { PluginRuntimeBoundary } from "./runtime-boundary";
import type { InstalledPlugin } from "./types";

export function PluginInstallationProvider({
  plugin,
  children,
}: {
  plugin: InstalledPlugin;
  children: ReactNode;
}) {
  const client = useHostRuntimeClient(plugin.serverId);
  return client ? (
    <PluginRuntimeBoundary plugin={plugin} client={client}>
      {children}
    </PluginRuntimeBoundary>
  ) : null;
}
