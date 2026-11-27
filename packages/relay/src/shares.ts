/**
 * Bot share links on the relay Worker (spec 37.13.2, ADR-0061 §5).
 *
 * The Worker only ever holds ciphertext: the daemon seals each bundle with AES-256-GCM and the key
 * rides in the link's `#k=` fragment, which browsers and HTTP clients never send. The serverId's
 * Durable Object owns the share list (`shareId -> sha256(writeToken), size, updatedAt_ms`), so the
 * 20-link limit, write auth and the per-link read rate are counted in one place. R2 holds
 * `shares/<shareId>` (the sealed bundle, tagged with its serverId so a GET finds the owning DO) and
 * `stopped/<shareId>` (an empty tombstone so a stopped link answers 410, not 404).
 */
import { bytesToBase64Url } from "./ownership.js";

/** Largest sealed bundle a PUT may carry: the 32 MiB archive limit plus the seal's header and tag. */
export const MAX_SHARE_BYTES = 32 * 1024 * 1024 + 1024;
/** Live links per serverId; the 21st `share_create` is refused and nothing is written. */
export const MAX_SHARES_PER_SERVER = 20;
/** Downloads per link per minute; excess gets 429. */
export const MAX_SHARE_GETS_PER_MINUTE = 60;
export const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
export const SHARE_STORAGE_KEY = "relay:shares";
export const SHARE_SERVER_HEADER = "x-desk-server-id";
export const SHARE_UPDATED_HEADER = "x-desk-share-updated";

export interface ShareRecord {
  tokenHash: string;
  size: number;
  updatedAt_ms: number;
}

/** The subset of the R2 binding the share route uses. */
export interface ShareBucket {
  head(key: string): Promise<{ customMetadata?: Record<string, string> } | null>;
  get(key: string): Promise<{
    body: ReadableStream;
    size: number;
    customMetadata?: Record<string, string>;
  } | null>;
  put(
    key: string,
    value: ArrayBuffer | Uint8Array | string,
    options?: { customMetadata?: Record<string, string>; httpMetadata?: Record<string, string> },
  ): Promise<unknown>;
  delete(key: string): Promise<void>;
}

interface ShareStorage {
  get<T>(key: string): Promise<T | undefined | null>;
  put(key: string, value: unknown): Promise<void>;
}
interface ShareSocket {
  send(data: string): void;
}

export const shareObjectKey = (shareId: string) => `shares/${shareId}`;
export const shareTombstoneKey = (shareId: string) => `stopped/${shareId}`;

export function sharePath(pathname: string): string | null {
  const match = /^\/s\/([A-Za-z0-9_-]{22})$/.exec(pathname);
  return match ? match[1] : null;
}

function randomToken(bytes: number): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return bytesToBase64Url(value);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function equalText(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index++)
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

function bearer(request: Request): string | null {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "");
  return match ? match[1] : null;
}

/** Reads a request body, refusing more than `limit` bytes without buffering the excess. */
export async function readShareBody(
  request: Request,
  limit = MAX_SHARE_BYTES,
): Promise<Uint8Array | Response> {
  if (Number(request.headers.get("content-length")) > limit)
    return new Response("Share too large", { status: 413 });
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = request.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.length;
        if (length > limit) {
          await reader.cancel().catch(() => {});
          return new Response("Share too large", { status: 413 });
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

/** The serverId DO's half of the share route: control frames and the PUT/GET/DELETE it is handed. */
export class RelayShares {
  private readonly rates = new Map<string, { start: number; count: number }>();
  private changes: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly storage: ShareStorage,
    private readonly bucket: () => ShareBucket | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.changes.then(run);
    this.changes = next.catch(() => {});
    return next;
  }
  private async records(): Promise<Record<string, ShareRecord>> {
    return (await this.storage.get<Record<string, ShareRecord>>(SHARE_STORAGE_KEY)) ?? {};
  }

  /** Handles `share_create` / `share_delete` from an authenticated control socket; false for others. */
  async controlMessage(socket: ShareSocket, message: Record<string, unknown>): Promise<boolean> {
    if (message.type !== "share_create" && message.type !== "share_delete") return false;
    const requestId = typeof message.requestId === "string" ? message.requestId.slice(0, 64) : "";
    const reply = (frame: Record<string, unknown>) => {
      try {
        socket.send(JSON.stringify({ v: 1, requestId, ...frame }));
      } catch {
        /* The daemon reconnects and retries. */
      }
    };
    if (message.v !== 1 || !requestId) return true;
    const bucket = this.bucket();
    if (!bucket) {
      reply({ type: "share_error", code: "unavailable" });
      return true;
    }
    if (message.type === "share_create") {
      await this.serial(async () => {
        const records = await this.records();
        if (Object.keys(records).length >= MAX_SHARES_PER_SERVER) {
          reply({ type: "share_error", code: "limit" });
          return;
        }
        const shareId = randomToken(16);
        const writeToken = randomToken(32);
        records[shareId] = { tokenHash: await sha256Hex(writeToken), size: 0, updatedAt_ms: 0 };
        await this.storage.put(SHARE_STORAGE_KEY, records);
        reply({ type: "share_created", shareId, writeToken });
      });
      return true;
    }
    const shareId = typeof message.shareId === "string" ? message.shareId : "";
    if (!SHARE_ID_PATTERN.test(shareId)) {
      reply({ type: "share_error", code: "invalid" });
      return true;
    }
    await this.serial(() => this.stop(bucket, shareId));
    reply({ type: "share_deleted", shareId });
    return true;
  }

  private async stop(bucket: ShareBucket, shareId: string): Promise<boolean> {
    const records = await this.records();
    if (!records[shareId]) return false;
    await bucket.put(shareTombstoneKey(shareId), new Uint8Array(0));
    await bucket.delete(shareObjectKey(shareId));
    delete records[shareId];
    this.rates.delete(shareId);
    await this.storage.put(SHARE_STORAGE_KEY, records);
    return true;
  }

  private async authorized(request: Request, shareId: string): Promise<ShareRecord | null> {
    const token = bearer(request);
    const record = (await this.records())[shareId];
    if (!token || !record) return null;
    return equalText(await sha256Hex(token), record.tokenHash) ? record : null;
  }

  /** A request the Worker routed here; `body` is the PUT body, already read within the limit. */
  async fetch(
    request: Request,
    shareId: string,
    serverId: string,
    body?: Uint8Array,
  ): Promise<Response> {
    const bucket = this.bucket();
    if (!bucket) return new Response("Sharing unavailable", { status: 503 });
    if (request.method === "PUT") {
      if (!body) return new Response("Body required", { status: 400 });
      return this.serial(async () => {
        if (!(await this.authorized(request, shareId)))
          return new Response("Unknown share", { status: 404 });
        const updatedAt_ms = this.now();
        await bucket.put(shareObjectKey(shareId), body, {
          customMetadata: { serverId, updatedAt_ms: String(updatedAt_ms) },
          httpMetadata: { contentType: "application/octet-stream" },
        });
        const records = await this.records();
        const record = records[shareId];
        if (!record) {
          // Stopped while the upload was in flight: the link stays stopped.
          await bucket.delete(shareObjectKey(shareId));
          return new Response("Share stopped", { status: 410 });
        }
        records[shareId] = { ...record, size: body.length, updatedAt_ms };
        await this.storage.put(SHARE_STORAGE_KEY, records);
        return Response.json({ updatedAt_ms });
      });
    }
    if (request.method === "DELETE") {
      return this.serial(async () => {
        if (!(await this.authorized(request, shareId)))
          return new Response("Unknown share", { status: 404 });
        await this.stop(bucket, shareId);
        return new Response(null, { status: 204 });
      });
    }
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("Method not allowed", { status: 405 });
    if (!(await this.records())[shareId]) return new Response("Link stopped", { status: 410 });
    const now = this.now();
    const rate = this.rates.get(shareId);
    const bucketRate = rate && now - rate.start < 60_000 ? rate : { start: now, count: 0 };
    this.rates.set(shareId, bucketRate);
    if (bucketRate !== rate) {
      const timer = setTimeout(() => {
        if (this.rates.get(shareId) === bucketRate) this.rates.delete(shareId);
      }, 60_000);
      unrefTimer(timer);
    }
    if (++bucketRate.count > MAX_SHARE_GETS_PER_MINUTE)
      return new Response("Too many downloads", { status: 429 });
    const object = await bucket.get(shareObjectKey(shareId));
    if (!object) return new Response("Not published", { status: 404 });
    const headers = {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(object.size),
      "Cache-Control": "no-store",
      [SHARE_UPDATED_HEADER]: object.customMetadata?.updatedAt_ms ?? "0",
    };
    if (request.method === "HEAD") {
      await object.body.cancel().catch(() => {});
      return new Response(null, { headers });
    }
    return new Response(object.body, { headers });
  }
}
