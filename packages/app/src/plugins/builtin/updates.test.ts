import { QueryClient } from "@tanstack/react-query";
import { BUILTIN_PLUGIN_MANIFESTS } from "@jagentdesk/protocol/builtin-plugins";
import { expect, it } from "vitest";
import {
  builtinPluginsQueryKey,
  observeBuiltinPluginUpdates,
  type BuiltinPluginQueryState,
  type BuiltinPluginUpdateSource,
} from "./updates";

class Updates implements BuiltinPluginUpdateSource {
  listeners = new Set<Parameters<BuiltinPluginUpdateSource["on"]>[1]>();
  on(_type: "plugins.builtin.changed", listener: Parameters<BuiltinPluginUpdateSource["on"]>[1]) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  send(plugins: BuiltinPluginQueryState["plugins"]) {
    for (const listener of this.listeners)
      listener({ type: "plugins.builtin.changed", payload: { plugins } });
  }
}
it("updates checking Devices live as probes settle, preserving manage permission and host isolation", () => {
  const client = new QueryClient();
  const source = new Updates();
  const pending = BUILTIN_PLUGIN_MANIFESTS.map((manifest) =>
    Object.assign({}, manifest, {
      requires: [...manifest.requires],
      enabled: manifest.defaultEnabled,
      available: true,
    }),
  );
  const key = builtinPluginsQueryKey("host");
  const otherKey = builtinPluginsQueryKey("other");
  client.setQueryData(key, { plugins: pending, canManage: false });
  client.setQueryData(otherKey, { plugins: pending, canManage: true });
  const stop = observeBuiltinPluginUpdates(source, client, "host");
  const devices = () =>
    client.getQueryData<BuiltinPluginQueryState>(key)!.plugins.find(({ id }) => id === "devices")!;
  expect(devices().available).toBe(true);
  expect(devices().unavailableReason).toBeUndefined();
  source.send(
    pending.map((p) =>
      p.id === "devices" ? { ...p, available: false, unavailableReason: "Install adb" } : p,
    ),
  );
  expect(devices().available).toBe(false);
  expect(devices().unavailableReason).toBe("Install adb");
  source.send(pending);
  expect(devices().available).toBe(true);
  expect(devices().unavailableReason).toBeUndefined();
  expect(client.getQueryData<BuiltinPluginQueryState>(key)!.canManage).toBe(false);
  expect(client.getQueryData<BuiltinPluginQueryState>(otherKey)!.plugins).toEqual(pending);
  stop();
  expect(source.listeners.size).toBe(0);
  client.clear();
});
