import {
  SshEnvironmentDetectRequestSchema,
  type SshEnvironmentDetectResponse,
} from "@jagentdesk/protocol/ssh/environment-schemas";
import { EnvironmentDetectError, type SshEnvironmentService } from "./service.js";

export type SshEnvironmentOutboundMessage = SshEnvironmentDetectResponse;

interface InboundMessage {
  type: string;
}

/**
 * Session entry point for `ssh.environment.*` (spec 25.12; the session gates `ssh.*` behind
 * `daemon.manage`). Returns false when the message belongs to someone else.
 */
export async function handleSshEnvironmentMessage(
  service: SshEnvironmentService,
  message: InboundMessage,
  emit: (message: SshEnvironmentOutboundMessage) => void,
): Promise<boolean> {
  if (message.type !== "ssh.environment.detect.request") return false;
  const request = SshEnvironmentDetectRequestSchema.parse(message);
  const base = { requestId: request.requestId, serverId: request.serverId };
  try {
    const environment = await service.detect(request.serverId, { force: request.force ?? false });
    emit({
      type: "ssh.environment.detect.response",
      payload: { ...base, environment, error: null, errorCode: null },
    });
  } catch (error) {
    // Every request gets a response; unclassified failures carry no code.
    const errorCode = error instanceof EnvironmentDetectError ? error.code : null;
    const text = error instanceof Error ? error.message : String(error);
    emit({
      type: "ssh.environment.detect.response",
      payload: { ...base, environment: null, error: text, errorCode },
    });
  }
  return true;
}
