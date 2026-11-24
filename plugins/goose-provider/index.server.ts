import type { PluginServerContext } from "@jagentdesk/plugin/server";
import { createGooseProvider } from "./server/provider.js";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createGooseProvider());
  return () => {};
}
