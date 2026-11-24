import type { PluginServerContext } from "@jagentdesk/plugin/server";
import { createAntigravityProvider } from "./server/provider.js";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createAntigravityProvider());
  return () => {};
}
