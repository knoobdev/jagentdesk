import {
  SshTelnetSessionCreateRequestSchema,
  SshTelnetSessionDestroyRequestSchema,
  type SshTelnetSessionCreateResponse,
  type SshTelnetSessionDestroyResponse,
} from "@jagentdesk/protocol/ssh/telnet-schemas";
import type { TelnetService } from "./service.js";

// Thin RPC adapter: the spec owner routes messages whose type starts with
// "ssh.telnet." here; anything else returns false.

export interface TelnetRequestMessage {
  type: string;
  requestId: string;
}

export type TelnetResponseMessage =
  | SshTelnetSessionCreateResponse
  | SshTelnetSessionDestroyResponse;

export type TelnetEmit = (response: TelnetResponseMessage) => void;

const CREATE_TYPE = "ssh.telnet.session.create.request";
const CREATE_RESPONSE_TYPE = "ssh.telnet.session.create.response";
const DESTROY_TYPE = "ssh.telnet.session.destroy.request";
const DESTROY_RESPONSE_TYPE = "ssh.telnet.session.destroy.response";

function firstIssue(error: { issues: Array<{ message: string }> }): string {
  return error.issues[0]?.message ?? "invalid request";
}

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function handleTelnetMessage(
  service: TelnetService,
  message: TelnetRequestMessage,
  emit: TelnetEmit,
): Promise<boolean> {
  switch (message.type) {
    case CREATE_TYPE: {
      const parsed = SshTelnetSessionCreateRequestSchema.safeParse(message);
      if (!parsed.success) {
        emit({
          type: CREATE_RESPONSE_TYPE,
          payload: {
            requestId: message.requestId,
            error: firstIssue(parsed.error),
            terminalId: null,
          },
        });
        return true;
      }
      try {
        const session = await service.createSession({
          address: parsed.data.address,
          port: parsed.data.port,
          cols: parsed.data.cols,
          rows: parsed.data.rows,
        });
        emit({
          type: CREATE_RESPONSE_TYPE,
          payload: { requestId: message.requestId, error: null, terminalId: session.id },
        });
      } catch (error) {
        emit({
          type: CREATE_RESPONSE_TYPE,
          payload: {
            requestId: message.requestId,
            error: failureText(error),
            terminalId: null,
          },
        });
      }
      return true;
    }
    case DESTROY_TYPE: {
      const parsed = SshTelnetSessionDestroyRequestSchema.safeParse(message);
      if (!parsed.success) {
        emit({
          type: DESTROY_RESPONSE_TYPE,
          payload: { requestId: message.requestId, error: firstIssue(parsed.error) },
        });
        return true;
      }
      const destroyed = await service.destroySession(parsed.data.terminalId);
      emit({
        type: DESTROY_RESPONSE_TYPE,
        payload: {
          requestId: message.requestId,
          error: destroyed ? null : `unknown telnet session: ${parsed.data.terminalId}`,
        },
      });
      return true;
    }
    default:
      return false;
  }
}
