import {
  localPortOfTarget,
  type BuiltinSessionContribution,
  type BuiltinSessionServices,
  type SessionInboundMessage,
} from "../../../packages/server/src/server/plugins/builtin/host-api.js";
import { DatabaseSession } from "./database-session.js";

export const DATABASE_RPC_METHODS = [
  "database/list",
  "database/add",
  "database/connect",
  "database/disconnect",
  "database/remove",
  "database/databases",
  "database/open-database",
  "database/schemas",
  "database/objects",
  "database/columns",
  "database/query",
  "database/exec",
  "database/foreign-keys",
  "database/indexes",
  "database/routines",
  "database/explain",
  "database/begin",
  "database/commit",
  "database/rollback",
] as const;

type DatabaseRpcMethod = (typeof DATABASE_RPC_METHODS)[number];
type DatabaseHandler = (rpc: DatabaseRpc, msg: { id: string }) => Promise<void>;
const HANDLERS: Record<DatabaseRpcMethod, DatabaseHandler> = {
  "database/list": (rpc, msg) => rpc.session.handleList(msg as never),
  "database/add": (rpc, msg) => rpc.session.handleAdd(msg as never),
  "database/connect": (rpc, msg) =>
    rpc.reopenRemoteDatabase(msg.id).then(() => rpc.session.handleConnect(msg as never)),
  "database/disconnect": (rpc, msg) => rpc.session.handleDisconnect(msg as never),
  "database/remove": (rpc, msg) => rpc.session.handleRemove(msg as never),
  "database/databases": (rpc, msg) => rpc.session.handleDatabases(msg as never),
  "database/open-database": (rpc, msg) => rpc.session.handleOpenDatabase(msg as never),
  "database/schemas": (rpc, msg) => rpc.session.handleSchemas(msg as never),
  "database/objects": (rpc, msg) => rpc.session.handleObjects(msg as never),
  "database/columns": (rpc, msg) => rpc.session.handleColumns(msg as never),
  "database/query": (rpc, msg) => rpc.session.handleQuery(msg as never),
  "database/exec": (rpc, msg) => rpc.session.handleExec(msg as never),
  "database/foreign-keys": (rpc, msg) => rpc.session.handleForeignKeys(msg as never),
  "database/indexes": (rpc, msg) => rpc.session.handleIndexes(msg as never),
  "database/routines": (rpc, msg) => rpc.session.handleRoutines(msg as never),
  "database/explain": (rpc, msg) => rpc.session.handleExplain(msg as never),
  "database/begin": (rpc, msg) => rpc.session.handleBegin(msg as never),
  "database/commit": (rpc, msg) => rpc.session.handleCommit(msg as never),
  "database/rollback": (rpc, msg) => rpc.session.handleRollback(msg as never),
};

/** The `database/*` RPC surface for one client session. It holds no streams of its own. */
export class DatabaseRpc implements BuiltinSessionContribution {
  readonly session: DatabaseSession;
  constructor(private readonly host: BuiltinSessionServices) {
    this.session = new DatabaseSession({
      host: { emit: (msg) => host.push(msg) },
      databaseRegistry: host.databases,
      logger: host.logger,
    });
  }
  stop() {}
  handle(msg: SessionInboundMessage): Promise<void> | undefined {
    const handler = HANDLERS[msg.type as DatabaseRpcMethod] as DatabaseHandler | undefined;
    return handler?.(this, msg as unknown as { id: string });
  }

  // A database reached through an SSH server listens on its fixed 127.0.0.1 port again before
  // the registry connects (ssh/remote-db).
  async reopenRemoteDatabase(databaseId: string): Promise<void> {
    const tunnels = this.host.remoteDb();
    const info = this.host.databases.list().find((candidate) => candidate.id === databaseId);
    const port = info ? localPortOfTarget(info.target) : null;
    if (!tunnels || port === null || !tunnels.isRemotePort(port)) return;
    await tunnels.reopenForLocalPort(port).catch((error: unknown) => {
      this.host.logger.warn({ err: error, databaseId }, "remote database tunnel failed");
    });
  }
}
