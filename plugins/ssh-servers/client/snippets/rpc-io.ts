import type { z } from "zod";

/**
 * The two daemon-client capabilities the SSH S5/S6 modules need: send a session
 * message and observe inbound session messages. The owner adapts `DaemonClient`
 * (`subscribeRawMessages` plus a raw session send) to this shape after the module
 * schemas are spread into `messages.ts`.
 */
export interface SshRpcIo {
  send(message: SshRpcRequest): void;
  subscribe(handler: (message: unknown) => void): () => void;
}

export interface SshRpcMessage {
  type: string;
  [field: string]: unknown;
}

export interface SshRpcRequest extends SshRpcMessage {
  requestId: string;
}

interface CorrelatedPayload {
  requestId: string;
  error: string | null;
}

export class SshRpcError extends Error {
  constructor(
    readonly requestType: string,
    message: string,
  ) {
    super(message);
  }
}

export class SshRpcTimeoutError extends SshRpcError {}

const DEFAULT_TIMEOUT_MS = 30_000;
let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `ssh_${Date.now().toString(36)}_${requestCounter}`;
}

function hasType(message: unknown, type: string): boolean {
  if (typeof message !== "object" || message === null || !("type" in message)) return false;
  return message.type === type;
}

/**
 * Sends `<name>.request` and resolves with the payload of the `<name>.response` that
 * carries the same requestId. A non-null `error` rejects with `SshRpcError`.
 */
export function sshRequest<TPayload extends CorrelatedPayload>(params: {
  io: SshRpcIo;
  message: SshRpcMessage;
  response: z.ZodType<{ type: string; payload: TPayload }>;
  timeoutMs?: number;
}): Promise<TPayload> {
  const requestId = nextRequestId();
  const responseType = params.message.type.replace(/\.request$/, ".response");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new SshRpcTimeoutError(params.message.type, "The host did not answer in time"));
    }, params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const unsubscribe = params.io.subscribe((message) => {
      if (!hasType(message, responseType)) return;
      const parsed = params.response.safeParse(message);
      if (!parsed.success || parsed.data.payload.requestId !== requestId) return;
      clearTimeout(timer);
      unsubscribe();
      if (parsed.data.payload.error !== null) {
        reject(new SshRpcError(params.message.type, parsed.data.payload.error));
      } else {
        resolve(parsed.data.payload);
      }
    });
    params.io.send({ ...params.message, requestId });
  });
}

/** Subscribes to one push-event type, validated by its schema. */
export function onSshEvent<TEvent>(
  io: SshRpcIo,
  schema: z.ZodType<TEvent>,
  handler: (event: TEvent) => void,
): () => void {
  return io.subscribe((message) => {
    const parsed = schema.safeParse(message);
    if (parsed.success) handler(parsed.data);
  });
}
