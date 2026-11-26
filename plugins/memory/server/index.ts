import path from "node:path";
import Database from "better-sqlite3";
import type {
  BuiltinDaemonRef,
  BuiltinServerHost,
} from "../../../packages/server/src/server/plugins/builtin/host-api.js";
import { registerMemoryTools } from "./agent-tools.js";
import { MemoryService } from "./service.js";
import { MemorySession } from "./session.js";
import { MemoryStore } from "./store.js";

let memoryServiceRef: BuiltinDaemonRef<MemoryService> | undefined;
/** The daemon's Memory service; tests reach their daemon's instance through this ref. */
export function memoryService(): BuiltinDaemonRef<MemoryService> {
  if (!memoryServiceRef) throw new Error("Memory built-in is not registered");
  return memoryServiceRef;
}

export function register(host: BuiltinServerHost) {
  // Spec 41: memories live in $JAGENTDESK_HOME/memory.sqlite (SQLite + FTS5). The store exists
  // while the plugin is off so its data stays; the port and tools do nothing then.
  const ref = host.daemonService(
    (context) =>
      new MemoryService({
        store: new MemoryStore(new Database(path.join(context.home, "memory.sqlite"))),
        agentManager: context.agentManager,
        projects: context.projects,
        broadcast: context.broadcast,
        logger: context.logger.child({ module: "memory" }),
        isEnabled: () => context.isEnabled("memory"),
      }),
    (service) => service.store.close(),
  );
  memoryServiceRef = ref;
  host.provide("memory", (daemon) => ref.get(daemon));
  host.rpc(
    "memory.",
    [
      "memory.list.request",
      "memory.save.request",
      "memory.delete.request",
      "memory.agent.request",
      "memory.settings.get.request",
      "memory.settings.set.request",
      "memory.rate.request",
      "memory.validate.request",
      "memory.graduation.preview.request",
      "memory.graduation.apply.request",
    ],
    (services) => new MemorySession(ref.get(services.daemon), services.push),
  );
  host.agentTools((registerTool, context) =>
    registerMemoryTools(registerTool, ref.get(context?.daemon), context),
  );
}
