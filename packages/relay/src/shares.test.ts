import { describe, it, expect } from "vitest";
import {
  RelayShares,
  MAX_SHARES_PER_SERVER,
  MAX_SHARE_GETS_PER_MINUTE,
  SHARE_STORAGE_KEY,
  SHARE_UPDATED_HEADER,
  readShareBody,
  sharePath,
  shareObjectKey,
  shareTombstoneKey,
  type ShareBucket,
  type ShareRecord,
} from "./shares.js";

class Storage {
  readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
}
class Bucket implements ShareBucket {
  readonly objects = new Map<string, { bytes: Uint8Array; meta?: Record<string, string> }>();
  async head(key: string) {
    const object = this.objects.get(key);
    return object ? { customMetadata: object.meta } : null;
  }
  async get(key: string) {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      body: new Response(object.bytes.slice()).body as ReadableStream,
      size: object.bytes.length,
      customMetadata: object.meta,
    };
  }
  async put(
    key: string,
    value: ArrayBuffer | Uint8Array | string,
    options?: { customMetadata?: Record<string, string> },
  ) {
    let bytes: Uint8Array;
    if (typeof value === "string") bytes = new TextEncoder().encode(value);
    else if (value instanceof Uint8Array) bytes = value.slice();
    else bytes = new Uint8Array(value);
    this.objects.set(key, { bytes, meta: options?.customMetadata });
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

function setup(withBucket = true) {
  const storage = new Storage();
  const bucket = new Bucket();
  let now = 1_000;
  const shares = new RelayShares(
    storage,
    () => (withBucket ? bucket : undefined),
    () => now,
  );
  const frames: Record<string, unknown>[] = [];
  const socket = { send: (text: string) => frames.push(JSON.parse(text)) };
  const create = async () => {
    await shares.controlMessage(socket, { type: "share_create", v: 1, requestId: "r1" });
    return frames.at(-1) as { type: string; shareId: string; writeToken: string; code?: string };
  };
  const put = (shareId: string, token: string, body: Uint8Array) =>
    shares.fetch(
      new Request(`http://relay/s/${shareId}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}` },
      }),
      shareId,
      "server-1",
      body,
    );
  const get = (shareId: string, method = "GET") =>
    shares.fetch(new Request(`http://relay/s/${shareId}`, { method }), shareId, "server-1");
  return {
    storage,
    bucket,
    shares,
    frames,
    socket,
    create,
    put,
    get,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

describe("relay bot shares", () => {
  it("creates a share, stores only the token hash, and serves what was PUT", async () => {
    const t = setup();
    const created = await t.create();
    expect(created.type).toBe("share_created");
    expect(created.shareId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(created.writeToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const records = t.storage.values.get(SHARE_STORAGE_KEY) as Record<string, ShareRecord>;
    expect(JSON.stringify(records)).not.toContain(created.writeToken);
    expect((await t.get(created.shareId)).status).toBe(404);

    const body = new Uint8Array([1, 2, 3, 4]);
    const putResponse = await t.put(created.shareId, created.writeToken, body);
    expect(putResponse.status).toBe(200);
    const object = t.bucket.objects.get(shareObjectKey(created.shareId));
    expect(object?.meta?.serverId).toBe("server-1");

    const got = await t.get(created.shareId);
    expect(got.status).toBe(200);
    expect(got.headers.get(SHARE_UPDATED_HEADER)).toBe("1000");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(body);
    const head = await t.get(created.shareId, "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("refuses a PUT or DELETE with a wrong write token", async () => {
    const t = setup();
    const created = await t.create();
    const wrong = "A".repeat(43);
    expect((await t.put(created.shareId, wrong, new Uint8Array([1]))).status).toBe(404);
    expect(t.bucket.objects.size).toBe(0);
    const deleted = await t.shares.fetch(
      new Request(`http://relay/s/${created.shareId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${wrong}` },
      }),
      created.shareId,
      "server-1",
    );
    expect(deleted.status).toBe(404);
  });

  it("update overwrites the same link", async () => {
    const t = setup();
    const created = await t.create();
    await t.put(created.shareId, created.writeToken, new Uint8Array([1]));
    t.tick(5_000);
    await t.put(created.shareId, created.writeToken, new Uint8Array([2, 2]));
    const got = await t.get(created.shareId);
    expect(got.headers.get(SHARE_UPDATED_HEADER)).toBe("6000");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(new Uint8Array([2, 2]));
  });

  it("stopping leaves a tombstone so the link answers 410", async () => {
    const t = setup();
    const created = await t.create();
    await t.put(created.shareId, created.writeToken, new Uint8Array([1]));
    await t.shares.controlMessage(t.socket, {
      type: "share_delete",
      v: 1,
      requestId: "r2",
      shareId: created.shareId,
    });
    expect(t.frames.at(-1)).toMatchObject({ type: "share_deleted", shareId: created.shareId });
    expect(t.bucket.objects.has(shareObjectKey(created.shareId))).toBe(false);
    expect(t.bucket.objects.has(shareTombstoneKey(created.shareId))).toBe(true);
    expect((await t.get(created.shareId)).status).toBe(410);
    expect((await t.put(created.shareId, created.writeToken, new Uint8Array([1]))).status).toBe(
      404,
    );
  });

  it("refuses the 21st live link and writes nothing", async () => {
    const t = setup();
    for (let index = 0; index < MAX_SHARES_PER_SERVER; index++)
      expect((await t.create()).type).toBe("share_created");
    const before = JSON.stringify([...t.storage.values]);
    const refused = await t.create();
    expect(refused).toMatchObject({ type: "share_error", code: "limit" });
    expect(JSON.stringify([...t.storage.values])).toBe(before);
    expect(t.bucket.objects.size).toBe(0);
  });

  it("limits downloads per link per minute", async () => {
    const t = setup();
    const created = await t.create();
    await t.put(created.shareId, created.writeToken, new Uint8Array([1]));
    for (let index = 0; index < MAX_SHARE_GETS_PER_MINUTE; index++)
      expect((await t.get(created.shareId)).status).toBe(200);
    expect((await t.get(created.shareId)).status).toBe(429);
    t.tick(60_001);
    expect((await t.get(created.shareId)).status).toBe(200);
  });

  it("answers unavailable without an R2 binding", async () => {
    const t = setup(false);
    expect(await t.create()).toMatchObject({ type: "share_error", code: "unavailable" });
  });

  it("parses only well-formed share paths", () => {
    expect(sharePath("/s/" + "a".repeat(22))).toBe("a".repeat(22));
    expect(sharePath("/s/" + "a".repeat(21))).toBeNull();
    expect(sharePath("/s/" + "a".repeat(22) + "/x")).toBeNull();
  });

  it("refuses an oversized body without buffering it", async () => {
    const response = await readShareBody(
      new Request("http://relay/s/x", { method: "PUT", body: new Uint8Array(11) }),
      10,
    );
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(413);
  });
});
