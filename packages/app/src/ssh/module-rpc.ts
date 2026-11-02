import type { z } from "zod";
import type { SshModuleError } from "@jagentdesk/protocol/ssh/module-rpc";

/**
 * What the SSH feature modules (SFTP, port forwarding) need from the daemon connection. The
 * owner implements it once on top of DaemonClient: `request` sends `{ type: "….request", ... }`
 * with a fresh requestId and resolves with the raw matching `….response` message; `subscribe`
 * delivers raw push messages of one type (`ssh.transfer.progress`, `ssh.forward.state`).
 */
export interface SshModuleTransport {
  request(message: { type: `${string}.request` } & Record<string, unknown>): Promise<unknown>;
  subscribe(type: string, handler: (message: unknown) => void): () => void;
}

export class SshModuleRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SshModuleRpcError";
  }
}

interface ResponseShape {
  payload: { error: SshModuleError | null };
}

/** Sends a request, validates the response with its schema, throws SshModuleRpcError on error. */
export async function callSshModule<S extends z.ZodType<ResponseShape>>(
  transport: SshModuleTransport,
  schema: S,
  message: { type: `${string}.request` } & Record<string, unknown>,
): Promise<z.infer<S>["payload"]> {
  const response = schema.parse(await transport.request(message));
  const { error } = response.payload;
  if (error) throw new SshModuleRpcError(error.code, error.message);
  return response.payload;
}

/** Subscribes to one push type, ignoring messages that do not match its schema. */
export function subscribeSshModule<T>(
  transport: SshModuleTransport,
  type: string,
  schema: z.ZodType<T>,
  handler: (message: T) => void,
): () => void {
  return transport.subscribe(type, (raw) => {
    const parsed = schema.safeParse(raw);
    if (parsed.success) handler(parsed.data);
  });
}
