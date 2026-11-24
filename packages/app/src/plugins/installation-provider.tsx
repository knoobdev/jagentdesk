import { getPluginClientApi } from "./client-state/api";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  JAgentDeskApiProvider,
  PluginComposersProvider,
  PluginRpcProvider,
  PluginTranslationProvider,
} from "@jagentdesk/plugin/client/host";
import { type ReactNode } from "react";
import { pluginComposersSource } from "./composer-items/source";
import { type InstalledPlugin } from "./types";

/** Every plugin surface renders under its installation: one query cache, one JAgentDesk client, RPCs. */
export function PluginInstallationProvider({
  plugin,
  children,
}: {
  plugin: InstalledPlugin;
  children: ReactNode;
}) {
  return (
    <QueryClientProvider client={plugin.queryClient}>
      <JAgentDeskApiProvider jagentdesk={getPluginClientApi(plugin).jagentdesk}>
        <PluginRpcProvider invoke={plugin.invoke} subscribe={plugin.subscribe}>
          <PluginTranslationProvider runtime={plugin.i18n}>
            <PluginComposersProvider source={pluginComposersSource(plugin)}>
              {children}
            </PluginComposersProvider>
          </PluginTranslationProvider>
        </PluginRpcProvider>
      </JAgentDeskApiProvider>
    </QueryClientProvider>
  );
}
