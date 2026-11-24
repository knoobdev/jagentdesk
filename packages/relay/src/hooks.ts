import { fromByteArray, toByteArray } from "base64-js";

export const MAX_HOOK_BODY_BYTES = 1024 * 1024;
export const HOOK_RESPONSE_TIMEOUT_MS = 2500;
export const HOOK_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const HOOK_STORAGE_KEY = "relay:slackHooks";
export interface HookDelivery {
  type: "hook_delivery";
  v: 1;
  deliveryId: string;
  hookId: string;
  kind: "slack";
  headers: Record<string, string>;
  bodyB64: string;
  receivedAt_ms: number;
}
export interface HookResponse {
  type: "hook_response";
  deliveryId: string;
  status: number;
  contentType?: string;
  body?: string;
}
export function encodeHookBody(body: Uint8Array): string {
  return fromByteArray(body);
}
export function decodeHookBody(body: string): Uint8Array {
  return toByteArray(body);
}
export function slackHookPath(pathname: string): { serverId: string; hookId: string } | null {
  const match = /^\/hooks\/slack\/([A-Za-z0-9_-]{1,200})\/([A-Za-z0-9_-]{43})$/.exec(pathname);
  return match ? { serverId: match[1], hookId: match[2] } : null;
}
export async function readHookBody(request: Request): Promise<Uint8Array | Response> {
  if (Number(request.headers.get("content-length")) > MAX_HOOK_BODY_BYTES)
    return new Response("Body too large", { status: 413 });
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = request.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.length;
        if (length > MAX_HOOK_BODY_BYTES) {
          await reader.cancel().catch(() => {});
          return new Response("Body too large", { status: 413 });
        }
        chunks.push(part.value);
      }
    } catch {
      return new Response("Incomplete body", { status: 400 });
    } finally {
      reader.releaseLock();
    }
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

function unrefTimer(timer: unknown): void {
  if (
    typeof timer === "object" &&
    timer !== null &&
    "unref" in timer &&
    typeof timer.unref === "function"
  )
    timer.unref();
}
interface HookSocket {
  send(data: string): void;
}
interface HookStorage {
  get<T>(key: string): Promise<T | undefined | null>;
  put(key: string, value: unknown): Promise<void>;
}

/** Only registered ids are durable. Request bytes and response waiters live with the HTTP request. */
export class RelayHooks {
  private readonly rates = new Map<string, { start: number; count: number }>();
  private readonly pending = new Map<
    string,
    { socket: HookSocket; finish: (response: Response) => void }
  >();
  private registrations: Promise<void> = Promise.resolve();
  constructor(
    private readonly storage: HookStorage,
    private readonly control: () => HookSocket | undefined,
  ) {}

  async controlMessage(socket: HookSocket, message: Record<string, unknown>): Promise<boolean> {
    if (message.type === "hook_response") {
      const pending =
        typeof message.deliveryId === "string" ? this.pending.get(message.deliveryId) : undefined;
      if (
        pending?.socket === socket &&
        Number.isInteger(message.status) &&
        Number(message.status) >= 200 &&
        Number(message.status) <= 599
      ) {
        try {
          pending.finish(
            new Response(typeof message.body === "string" ? message.body : null, {
              status: Number(message.status),
              headers: {
                "Content-Type":
                  typeof message.contentType === "string" ? message.contentType : "text/plain",
              },
            }),
          );
        } catch {
          pending.finish(new Response("Invalid hook response", { status: 503 }));
        }
      }
      return true;
    }
    if (message.type !== "hook_register" && message.type !== "hook_unregister") return false;
    if (
      message.v !== 1 ||
      typeof message.hookId !== "string" ||
      !HOOK_ID_PATTERN.test(message.hookId) ||
      (message.type === "hook_register" && message.kind !== "slack")
    )
      return true;
    const hookId = message.hookId;
    const register = message.type === "hook_register";
    const operation = this.registrations.then(async () => {
      const ids = new Set((await this.storage.get<string[]>(HOOK_STORAGE_KEY)) ?? []);
      if (register) ids.add(hookId);
      else {
        ids.delete(hookId);
        this.rates.delete(hookId);
      }
      await this.storage.put(HOOK_STORAGE_KEY, [...ids]);
      socket.send(
        JSON.stringify({ type: register ? "hook_registered" : "hook_unregistered", v: 1, hookId }),
      );
      return;
    });
    this.registrations = operation.catch(() => {});
    await operation;
    return true;
  }

  async fetch(request: Request, hookId: string): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    await this.registrations;
    const ids = (await this.storage.get<string[]>(HOOK_STORAGE_KEY)) ?? [];
    if (!ids.includes(hookId)) return new Response("Unknown hook", { status: 404 });
    const socket = this.control();
    if (!socket) return new Response("Daemon unavailable", { status: 503 });
    const now = Date.now();
    const rate = this.rates.get(hookId);
    const bucket = rate && now - rate.start < 60_000 ? rate : { start: now, count: 0 };
    this.rates.set(hookId, bucket);
    if (bucket !== rate) {
      // A live timer prevents DO hibernation from resetting the rate window.
      // Persisting counters would violate the ids-only hook storage contract.
      const timer = setTimeout(() => {
        if (this.rates.get(hookId) === bucket) this.rates.delete(hookId);
      }, 60_000);
      unrefTimer(timer);
    }
    if (++bucket.count > 120) return new Response("Too many hook requests", { status: 429 });
    const body = await readHookBody(request);
    if (body instanceof Response) return body;
    const headers: Record<string, string> = {};
    for (const name of [
      "x-slack-signature",
      "x-slack-request-timestamp",
      "x-slack-retry-num",
      "content-type",
    ]) {
      const value = request.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    const deliveryId = crypto.randomUUID();
    const delivery: HookDelivery = {
      type: "hook_delivery",
      v: 1,
      deliveryId,
      hookId,
      kind: "slack",
      headers,
      bodyB64: encodeHookBody(body),
      receivedAt_ms: now,
    };
    const response = new Promise<Response>((resolve) => {
      this.pending.set(deliveryId, { socket, finish: resolve });
    });
    const timer = setTimeout(() => {
      this.pending
        .get(deliveryId)
        ?.finish(new Response("Daemon response timed out", { status: 503 }));
    }, HOOK_RESPONSE_TIMEOUT_MS);
    try {
      socket.send(JSON.stringify(delivery));
    } catch {
      this.pending.get(deliveryId)?.finish(new Response("Daemon unavailable", { status: 503 }));
    }
    return response.finally(() => {
      clearTimeout(timer);
      this.pending.delete(deliveryId);
    });
  }
}
