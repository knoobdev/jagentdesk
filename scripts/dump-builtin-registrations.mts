// Prints the RPC and agent tool names each migrated built-in registers through the real daemon
// host, as JSON keyed by plugin id. Used by compare-builtin-contracts.mjs.
//   npx tsx scripts/dump-builtin-registrations.mts docker jira
import type { BuiltinPluginId } from "@jagentdesk/protocol/builtin-plugins";
import { BuiltinServerRegistry } from "../packages/server/src/server/plugins/builtin/host.js";

// Tool installers only build closures; any service they capture is never called here.
const inert: unknown = new Proxy(function inert() {}, {
  get: (_target, key) => (key === "then" ? undefined : inert),
  apply: () => inert,
  construct: () => inert as object,
});

const ids = process.argv.slice(2) as BuiltinPluginId[];
const result: Record<string, { rpc: string[]; tools: string[] }> = {};
for (const id of ids) {
  const registry = new BuiltinServerRegistry();
  const module = (await import(`../plugins/${id}/server/index.ts`)) as {
    register(host: ReturnType<BuiltinServerRegistry["forPlugin"]>): void;
  };
  module.register(registry.forPlugin(id));
  const tools: string[] = [];
  const context = { service: () => inert as never };
  for (const slot of registry.toolSlots())
    registry.registerAgentTools(undefined, (name) => tools.push(name), undefined, context, slot);
  result[id] = { rpc: registry.rpcNames(), tools: [...new Set(tools)].sort() };
}
process.stdout.write(JSON.stringify(result));
