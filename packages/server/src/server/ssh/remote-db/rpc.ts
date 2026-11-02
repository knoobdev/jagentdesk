import {
  SshRemoteDbPrepareRequestSchema,
  type SshRemoteDbPrepareResponse,
} from "@jagentdesk/protocol/ssh/remote-db-schemas";
import { RemoteDbError, type RemoteDbTunnels } from "./service.js";

interface InboundMessage {
  type: string;
}

/** Session entry point for `ssh.remote_db.*` (`ssh.*` needs `daemon.manage`, 25.12). */
export async function handleSshRemoteDbMessage(
  tunnels: RemoteDbTunnels,
  message: InboundMessage,
  emit: (message: SshRemoteDbPrepareResponse) => void,
): Promise<boolean> {
  if (message.type !== "ssh.remote_db.prepare.request") return false;
  const request = SshRemoteDbPrepareRequestSchema.parse(message);
  const base = { requestId: request.requestId, serverId: request.serverId };
  try {
    const prepared = await tunnels.prepare(request);
    emit({
      type: "ssh.remote_db.prepare.response",
      payload: { ...base, ...prepared, error: null, errorCode: null },
    });
  } catch (error) {
    // Every request gets a response; unclassified failures carry no code.
    const errorCode = error instanceof RemoteDbError ? error.code : null;
    const text = error instanceof Error ? error.message : String(error);
    emit({
      type: "ssh.remote_db.prepare.response",
      payload: { ...base, localPort: null, connection: null, error: text, errorCode },
    });
  }
  return true;
}
