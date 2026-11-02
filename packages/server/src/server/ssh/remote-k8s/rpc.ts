import {
  SshRemoteK8sImportRequestSchema,
  type SshRemoteK8sImportResponse,
} from "@jagentdesk/protocol/ssh/remote-k8s-schemas";
import { RemoteK8sError, type RemoteK8sClusters } from "./service.js";

interface InboundMessage {
  type: string;
}

/** Session entry point for `ssh.remote_k8s.*` (`ssh.*` needs `daemon.manage`, 25.12). */
export async function handleSshRemoteK8sMessage(
  clusters: RemoteK8sClusters,
  message: InboundMessage,
  emit: (message: SshRemoteK8sImportResponse) => void,
): Promise<boolean> {
  if (message.type !== "ssh.remote_k8s.import.request") return false;
  const request = SshRemoteK8sImportRequestSchema.parse(message);
  const base = { requestId: request.requestId, serverId: request.serverId };
  try {
    const clusterInput = await clusters.import(request);
    emit({
      type: "ssh.remote_k8s.import.response",
      payload: { ...base, clusterInput, error: null, errorCode: null },
    });
  } catch (error) {
    // Every request gets a response; unclassified failures carry no code.
    const errorCode = error instanceof RemoteK8sError ? error.code : null;
    const text = error instanceof Error ? error.message : String(error);
    emit({
      type: "ssh.remote_k8s.import.response",
      payload: { ...base, clusterInput: null, error: text, errorCode },
    });
  }
  return true;
}
