import {
  SshDockerAttachRequestSchema,
  SshDockerDetachRequestSchema,
  type SshDockerAttachResponse,
  type SshDockerDetachResponse,
} from "@jagentdesk/protocol/ssh/remote-docker-schemas";
import { RemoteDockerError, type RemoteDockerHosts } from "./hosts.js";

export type SshRemoteDockerOutboundMessage = SshDockerAttachResponse | SshDockerDetachResponse;

interface InboundMessage {
  type: string;
}

/**
 * Session entry point for `ssh.docker.attach|detach` (spec 25.12; `ssh.*` needs `daemon.manage`).
 * A session should detach whatever it attached when it closes. Returns false for other messages.
 */
export async function handleSshRemoteDockerMessage(
  hosts: RemoteDockerHosts,
  message: InboundMessage,
  emit: (message: SshRemoteDockerOutboundMessage) => void,
): Promise<boolean> {
  if (message.type === "ssh.docker.attach.request") {
    const request = SshDockerAttachRequestSchema.parse(message);
    const base = { requestId: request.requestId, serverId: request.serverId };
    try {
      const attachment = await hosts.attach(request.serverId);
      emit({
        type: "ssh.docker.attach.response",
        payload: {
          ...base,
          dockerHost: attachment.dockerHost,
          remoteSocketPath: attachment.remoteSocketPath,
          error: null,
          errorCode: null,
        },
      });
    } catch (error) {
      // Every request gets a response; unclassified failures carry no code.
      const errorCode = error instanceof RemoteDockerError ? error.code : null;
      const text = error instanceof Error ? error.message : String(error);
      emit({
        type: "ssh.docker.attach.response",
        payload: { ...base, dockerHost: null, remoteSocketPath: null, error: text, errorCode },
      });
    }
    return true;
  }
  if (message.type === "ssh.docker.detach.request") {
    const request = SshDockerDetachRequestSchema.parse(message);
    hosts.detach(request.serverId);
    emit({
      type: "ssh.docker.detach.response",
      payload: { requestId: request.requestId, serverId: request.serverId, error: null },
    });
    return true;
  }
  return false;
}
