import { fromByteArray, toByteArray } from "base64-js";

export const MAX_HOOK_BODY_BYTES = 1024 * 1024;
export const HOOK_RESPONSE_TIMEOUT_MS = 2500;
export const HOOK_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const HOOK_KINDS = ["slack", "github", "gitlab", "telegram"] as const;
export type HookKind = (typeof HOOK_KINDS)[number];
/** Spec 37.9: the only request headers the Worker forwards for each kind. */
export const HOOK_FORWARDED_HEADERS: Record<HookKind, readonly string[]> = {
  slack: ["x-slack-signature", "x-slack-request-timestamp", "x-slack-retry-num", "content-type"],
  github: [
    "x-hub-signature-256",
    "x-github-event",
    "x-github-delivery",
    "x-github-hook-id",
    "content-type",
  ],
  gitlab: [
    "x-gitlab-token",
    "x-gitlab-event",
    "x-gitlab-event-uuid",
    "x-gitlab-instance",
    "content-type",
  ],
  telegram: ["x-telegram-bot-api-secret-token", "content-type"],
};
/** Slack's key predates the other kinds; keep it so registered Slack hooks survive the upgrade. */
export const HOOK_STORAGE_KEY = "relay:slackHooks";
export function hookStorageKey(kind: HookKind): string {
  return kind === "slack" ? HOOK_STORAGE_KEY : `relay:${kind}Hooks`;
}
export function isHookKind(value: unknown): value is HookKind {
  return typeof value === "string" && (HOOK_KINDS as readonly string[]).includes(value);
}
export interface HookDelivery {
  type: "hook_delivery";
  v: 1;
  deliveryId: string;
  hookId: string;
  kind: HookKind;
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
export function hookPath(
  pathname: string,
): { kind: HookKind; serverId: string; hookId: string } | null {
  const match =
    /^\/hooks\/(slack|github|gitlab|telegram)\/([A-Za-z0-9_-]{1,200})\/([A-Za-z0-9_-]{43})$/.exec(
      pathname,
    );
  return match && isHookKind(match[1])
    ? { kind: match[1], serverId: match[2], hookId: match[3] }
    : null;
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
      (message.type === "hook_register" && !isHookKind(message.kind))
    )
      return true;
    const hookId = message.hookId;
    const register = message.type === "hook_register" ? (message.kind as HookKind) : null;
    const operation = this.registrations.then(async () => {
      // One kind per hookId: registering moves it; unregistering (no kind on the frame) clears every kind.
      for (const kind of HOOK_KINDS) {
        const key = hookStorageKey(kind);
        const stored = (await this.storage.get<string[]>(key)) ?? [];
        const ids = new Set(stored);
        if (kind === register) ids.add(hookId);
        else ids.delete(hookId);
        if (ids.size !== stored.length || stored.some((id) => !ids.has(id)))
          await this.storage.put(key, [...ids]);
      }
      if (!register) this.rates.delete(hookId);
      socket.send(
        JSON.stringify({ type: register ? "hook_registered" : "hook_unregistered", v: 1, hookId }),
      );
      return;
    });
    this.registrations = operation.catch(() => {});
    await operation;
    return true;
  }

  async fetch(request: Request, hookId: string, kind: HookKind = "slack"): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    await this.registrations;
    // A hookId registered for another kind is unknown on this route (spec 37.9).
    const ids = (await this.storage.get<string[]>(hookStorageKey(kind))) ?? [];
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
    for (const name of HOOK_FORWARDED_HEADERS[kind]) {
      const value = request.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    const deliveryId = crypto.randomUUID();
    const delivery: HookDelivery = {
      type: "hook_delivery",
      v: 1,
      deliveryId,
      hookId,
      kind,
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
