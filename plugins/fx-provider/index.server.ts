import type { PluginServerContext } from "@jagentdesk/plugin/server";
import { createFxProvider } from "./server/provider.js";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createFxProvider());
  return () => {};
}
