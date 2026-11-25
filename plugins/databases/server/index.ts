import type { BuiltinServerHost } from "../../../packages/server/src/server/plugins/builtin/host-api.js";
import { DATABASE_RPC_METHODS, DatabaseRpc } from "./session.js";
import { registerSqlTools } from "./agent-tools.js";

export function register(host: BuiltinServerHost) {
  host.rpc("database/", DATABASE_RPC_METHODS, (services) => new DatabaseRpc(services));
  // Turning the plugin off closes every open connection; saved connections stay on disk.
  host.backgroundService((services) => ({
    start: () => {},
    stop: async () => {
      await Promise.all(
        services.databases.list().map((entry) => services.databases.disconnect(entry.id)),
      );
    },
  }));
  host.agentTools((registerTool, context) => registerSqlTools(registerTool, context));
}
