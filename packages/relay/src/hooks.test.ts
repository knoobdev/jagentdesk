import { describe, it, expect } from "vitest";
import {
  RelayHooks,
  HOOK_STORAGE_KEY,
  encodeHookBody,
  decodeHookBody,
  hookPath,
  hookStorageKey,
  type HookDelivery,
  type HookKind,
} from "./hooks.js";
class Storage {
  readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}
const hookId = "a".repeat(43);
function setup() {
  const storage = new Storage();
  const deliveries: HookDelivery[] = [];
  let online = true;
  let respond = true;
  const socket = {
    send(text: string) {
      const frame = JSON.parse(text);
      if (frame.type !== "hook_delivery") return;
      deliveries.push(frame);
      if (respond)
        void hooks.controlMessage(socket, {
          type: "hook_response",
          deliveryId: frame.deliveryId,
          status: 200,
          contentType: "application/json",
          body: '{"challenge":"ok"}',
        });
    },
  };
  const hooks = new RelayHooks(storage, () => (online ? socket : undefined));
  return {
    storage,
    hooks,
    socket,
    deliveries,
    offline: () => {
      online = false;
    },
    noResponse: () => {
      respond = false;
    },
  };
}
const request = (body = "body") =>
  new Request("http://localhost/hooks/slack/server/" + hookId, {
    method: "POST",
    body,
    headers: {
      "x-slack-signature": "v0=test",
      "x-slack-request-timestamp": "42",
      authorization: "must-not-forward",
    },
  });
describe("Slack relay hooks", () => {
  it("forwards exact bytes and only signature headers; stores only registered ids", async () => {
    const { hooks, socket, storage, deliveries } = setup();
    await hooks.controlMessage(socket, { type: "hook_register", v: 1, kind: "slack", hookId });
    const body = '{ "text": "hello 👋" }';
    const response = await hooks.fetch(request(body), hookId);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: "ok" });
    expect(new TextDecoder().decode(decodeHookBody(deliveries[0].bodyB64))).toBe(body);
    expect(deliveries[0].headers).toEqual({
      "content-type": "text/plain;charset=UTF-8",
      "x-slack-signature": "v0=test",
      "x-slack-request-timestamp": "42",
    });
    expect([...storage.values]).toEqual([[HOOK_STORAGE_KEY, [hookId]]]);
    expect(encodeHookBody(new Uint8Array([0, 255, 12]))).toBe("AP8M");
  });
  it("rejects unknown, disconnected, oversized and unregistered deliveries", async () => {
    const { hooks, socket, offline } = setup();
    expect((await hooks.fetch(request(), hookId)).status).toBe(404);
    await hooks.controlMessage(socket, { type: "hook_register", v: 1, kind: "slack", hookId });
    expect((await hooks.fetch(request("a".repeat(1024 * 1024 + 1)), hookId)).status).toBe(413);
    offline();
    expect((await hooks.fetch(request(), hookId)).status).toBe(503);
    await hooks.controlMessage(socket, { type: "hook_unregister", v: 1, hookId });
    expect((await hooks.fetch(request(), hookId)).status).toBe(404);
  });
  it("limits each hook to 120 requests per minute", async () => {
    const { hooks, socket } = setup();
    await hooks.controlMessage(socket, { type: "hook_register", v: 1, kind: "slack", hookId });
    for (let i = 0; i < 120; i++) expect((await hooks.fetch(request(), hookId)).status).toBe(200);
    expect((await hooks.fetch(request(), hookId)).status).toBe(429);
  });
  it("returns 503 after the response deadline, and ignores responses from another socket", async () => {
    const { hooks, socket, deliveries, noResponse } = setup();
    await hooks.controlMessage(socket, { type: "hook_register", v: 1, kind: "slack", hookId });
    noResponse();
    const response = hooks.fetch(request(), hookId);
    await expect.poll(() => deliveries.length).toBe(1);
    await hooks.controlMessage(
      { send() {} },
      { type: "hook_response", deliveryId: deliveries[0].deliveryId, status: 200 },
    );
    expect((await response).status).toBe(503);
  });
  it("serializes concurrent registrations so none are lost", async () => {
    const { hooks, socket, storage } = setup();
    await Promise.all(
      [hookId, "b".repeat(43)].map((id) =>
        hooks.controlMessage(socket, { type: "hook_register", v: 1, kind: "slack", hookId: id }),
      ),
    );
    expect(await storage.get(HOOK_STORAGE_KEY)).toEqual([hookId, "b".repeat(43)]);
  });
});
describe("Shared hook route (spec 37.9)", () => {
  const kindRequest = (kind: string, headers: Record<string, string>, body = "{}") =>
    new Request(`http://localhost/hooks/${kind}/server/${hookId}`, {
      method: "POST",
      body,
      headers: { ...headers, "content-type": "application/json", cookie: "must-not-forward" },
    });
  it("parses every kind and rejects others", () => {
    for (const kind of ["slack", "github", "gitlab", "telegram"])
      expect(hookPath(`/hooks/${kind}/srv/${hookId}`)).toEqual({ kind, serverId: "srv", hookId });
    expect(hookPath(`/hooks/linear/srv/${hookId}`)).toBeNull();
    expect(hookPath(`/hooks/github/srv/${hookId}x`)).toBeNull();
  });
  it("forwards only the kind's headers", async () => {
    const { hooks, socket, deliveries } = setup();
    const cases: [string, Record<string, string>, Record<string, string>][] = [
      [
        "github",
        {
          "x-hub-signature-256": "sha256=ab",
          "x-github-event": "issues",
          "x-github-delivery": "d-1",
          "x-github-hook-id": "7",
          "x-gitlab-token": "leak",
          "x-slack-signature": "leak",
        },
        {
          "x-hub-signature-256": "sha256=ab",
          "x-github-event": "issues",
          "x-github-delivery": "d-1",
          "x-github-hook-id": "7",
        },
      ],
      [
        "gitlab",
        {
          "x-gitlab-token": "t",
          "x-gitlab-event": "Note Hook",
          "x-gitlab-event-uuid": "u-1",
          "x-gitlab-instance": "https://gitlab.com",
          "x-hub-signature-256": "leak",
        },
        {
          "x-gitlab-token": "t",
          "x-gitlab-event": "Note Hook",
          "x-gitlab-event-uuid": "u-1",
          "x-gitlab-instance": "https://gitlab.com",
        },
      ],
      [
        "telegram",
        { "x-telegram-bot-api-secret-token": "s", "x-gitlab-token": "leak" },
        { "x-telegram-bot-api-secret-token": "s" },
      ],
    ];
    for (const [kind, sent, forwarded] of cases) {
      await hooks.controlMessage(socket, { type: "hook_register", v: 1, kind, hookId });
      const response = await hooks.fetch(kindRequest(kind, sent), hookId, kind as HookKind);
      expect(response.status).toBe(200);
      const delivery = deliveries.at(-1)!;
      expect(delivery.kind).toBe(kind);
      expect(delivery.headers).toEqual({ ...forwarded, "content-type": "application/json" });
    }
  });
  it("answers 404 when the hookId is registered for another kind, and moves it on re-register", async () => {
    const { hooks, socket, storage } = setup();
    await hooks.controlMessage(socket, { type: "hook_register", v: 1, kind: "github", hookId });
    expect((await hooks.fetch(kindRequest("gitlab", {}), hookId, "gitlab")).status).toBe(404);
    expect((await hooks.fetch(kindRequest("slack", {}), hookId, "slack")).status).toBe(404);
    expect((await hooks.fetch(kindRequest("github", {}), hookId, "github")).status).toBe(200);
    await hooks.controlMessage(socket, { type: "hook_register", v: 1, kind: "telegram", hookId });
    expect((await hooks.fetch(kindRequest("github", {}), hookId, "github")).status).toBe(404);
    expect(await storage.get(hookStorageKey("github"))).toEqual([]);
    expect(await storage.get(hookStorageKey("telegram"))).toEqual([hookId]);
    await hooks.controlMessage(socket, { type: "hook_unregister", v: 1, hookId });
    expect((await hooks.fetch(kindRequest("telegram", {}), hookId, "telegram")).status).toBe(404);
  });
  it("ignores registrations of unknown kinds", async () => {
    const { hooks, socket, storage } = setup();
    await hooks.controlMessage(socket, { type: "hook_register", v: 1, kind: "linear", hookId });
    expect(storage.values.size).toBe(0);
  });
  it("keeps the rate limit and body cap on every kind", async () => {
    const { hooks, socket } = setup();
    await hooks.controlMessage(socket, { type: "hook_register", v: 1, kind: "telegram", hookId });
    expect(
      (
        await hooks.fetch(
          kindRequest("telegram", {}, "a".repeat(1024 * 1024 + 1)),
          hookId,
          "telegram",
        )
      ).status,
    ).toBe(413);
    for (let i = 1; i < 120; i++)
      expect((await hooks.fetch(kindRequest("telegram", {}), hookId, "telegram")).status).toBe(200);
    expect((await hooks.fetch(kindRequest("telegram", {}), hookId, "telegram")).status).toBe(429);
  });
});
