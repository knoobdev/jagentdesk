import type { AudioEngine } from "@/audio";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { PluginRegistry } from "./registry";
import { pluginSettingsKey, pluginSettingsPrefix } from "./settings/query";
interface CatalogSyncInput {
  serverId: string;
  client: DaemonClient;
  audio: Pick<AudioEngine, "play"> | null;
  connected: boolean;
  /** `null` while `server_info` has not yet arrived for this host. */
  supported: boolean | null;
  registry: Pick<
    PluginRegistry,
    "installCatalog" | "getSnapshot" | "removeHost" | "setCatalogStatus"
  >;
  onCatalogChanged?: () => void;
}
export function syncPluginCatalog({
  serverId,
  client,
  audio,
  connected,
  supported,
  registry,
  onCatalogChanged,
}: CatalogSyncInput): () => void {
  if (supported === null) {
    // Plugin support is unknown until `server_info` arrives; keep status "loading" so cold-launch
    // plugin notification taps wait instead of falling back prematurely.
    return () => {};
  }
  let cancelled = false;
  let refreshQueue = Promise.resolve();
  if (!supported || !audio) {
    registry.removeHost(serverId);
    registry.setCatalogStatus(serverId, "ready");
    return () => {};
  }
  if (!connected) {
    return () => {};
  }
  registry.setCatalogStatus(serverId, "loading");
  const refresh = (replacePluginId?: string) => {
    refreshQueue = refreshQueue.then(() => {
      if (cancelled) return undefined;
      registry.setCatalogStatus(serverId, "loading");
      return client
        .getPluginCatalog()
        .then((catalog) => {
          if (!cancelled) {
            registry.installCatalog(serverId, catalog, {
              replacePluginId,
              client,
              audio,
            });
            registry.setCatalogStatus(serverId, "ready");
          }
          return undefined;
        })
        .catch((error) => {
          if (!cancelled) {
            registry.setCatalogStatus(serverId, "error");
            console.warn(`[Plugins] Failed to load catalog for ${serverId}`, error);
          }
          return undefined;
        });
    });
    return refreshQueue;
  };
  // The fork's daemon pushes status events to every session (no explicit event
  // subscriptions), so load the catalog now and react to the two plugin statuses.
  void refresh().then(() => {
    if (cancelled) return undefined;
    for (const plugin of registry.getSnapshot()) {
      if (plugin.serverId === serverId)
        void plugin.queryClient.invalidateQueries({
          queryKey: pluginSettingsPrefix,
          refetchType: "all",
        });
    }
    return undefined;
  });
  const unsubscribe = client.on("status", (message) => {
    if (message.payload.status === "plugin_settings_changed") {
      const { pluginId, settingsId } = message.payload;
      if (typeof settingsId === "string") {
        const plugin = registry
          .getSnapshot()
          .find((item) => item.serverId === serverId && item.id === pluginId);
        void plugin?.queryClient.invalidateQueries({ queryKey: pluginSettingsKey(settingsId) });
      }
    }
    if (message.payload.status === "plugin_catalog_changed") {
      onCatalogChanged?.();
      const pluginId = message.payload.pluginId;
      if (typeof pluginId === "string") void refresh(pluginId);
    }
  });
  return () => {
    cancelled = true;
    unsubscribe();
  };
}
