import * as pluginUsageRuntime from "@jagentdesk/plugin/server/usage";
import { createRequire } from "node:module";
import * as pluginServerRuntime from "@jagentdesk/plugin/server";
import * as pluginSharedRuntime from "@jagentdesk/plugin";
import * as pluginProviderRuntime from "@jagentdesk/plugin/server/provider";
import * as pluginAcpRuntime from "@jagentdesk/plugin/server/acp";
import type { PluginServerContribution } from "@jagentdesk/plugin/server";
import * as zod from "zod";
import { isPluginClientOnlySdkSpecifier } from "./plugin-sdk-specifiers.js";

const nodeRequire = createRequire(import.meta.url);

function runtimeRequire(name: string): unknown {
  if (isPluginClientOnlySdkSpecifier(name)) {
    throw new Error(`${name} is available only in plugin client code`);
  }
  if (name === "@jagentdesk/plugin") return pluginSharedRuntime;
  if (name === "@jagentdesk/plugin/server") return pluginServerRuntime;
  if (name === "@jagentdesk/plugin/server/provider") return pluginProviderRuntime;
  if (name === "@jagentdesk/plugin/server/acp") return pluginAcpRuntime;
  if (name === "@jagentdesk/plugin/server/usage") return pluginUsageRuntime;
  if (name === "zod") return zod;
  if (name === "@jagentdesk/plugin/client/host")
    throw new Error(`${name} is private to the app host`);
  return nodeRequire(name);
}

export function evaluateBundle(bundle: string): PluginServerContribution {
  const evaluate: (source: string) => unknown = globalThis.eval;
  const factory = evaluate(bundle);
  if (typeof factory !== "function") throw new Error("Plugin server bundle is not executable");
  const exports = factory(runtimeRequire);
  const setup =
    exports !== null && typeof exports === "object" ? Reflect.get(exports, "default") : undefined;
  if (typeof setup !== "function") {
    throw new Error("Plugin server bundle must default export a function");
  }
  return setup as PluginServerContribution;
}
