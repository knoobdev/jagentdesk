import type { PluginServerContext } from "@jagentdesk/plugin/server";
import { createHermesProvider } from "./server/provider.js";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createHermesProvider());
  return () => {};
}
