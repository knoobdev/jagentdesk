import { describe, expect, test } from "vitest";
import { createPublicKey, generateKeyPairSync, sign as cryptoSign, verify } from "node:crypto";
import pino from "pino";
import { createRelayOwnershipGuard } from "./relay-ownership.js";
import { RELAY_OWNERSHIP_SIGNATURE_PREFIX, type RelayOwnershipSigner } from "./daemon-keypair.js";
import type { RelaySocketLike } from "./relay-transport.js";

class FakeSocket implements RelaySocketLike {
  readyState = 1;
  sent: string[] = [];
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: "message" | "close" | "error", listener: (...args: unknown[]) => void) {
    const handlers = this.listeners.get(event) ?? [];
    handlers.push(listener);
    this.listeners.set(event, handlers);
  }

  once(event: "close" | "error", listener: (...args: unknown[]) => void) {
    this.on(event, listener);
  }

  send(data: string | Uint8Array | ArrayBuffer) {
    this.sent.push(String(data));
  }

  closed: Array<{ code?: number; reason?: string }> = [];
  close(code?: number, reason?: string) {
    this.closed.push({ code, reason });
  }
  terminate() {}

  emitMessage(data: string) {
    for (const listener of (this.listeners.get("message") ?? []).slice()) {
      listener(data, false);
    }
  }

  emitClose() {
    for (const listener of (this.listeners.get("close") ?? []).slice()) {
      listener(1006, "");
    }
  }
}

function createSigner(): RelayOwnershipSigner & { verify(nonce: string, sig: string): boolean } {
  const keys = generateKeyPairSync("ed25519");
  const jwk = keys.publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  return {
    publicKeyB64url: String(jwk.x),
    signOwnership(serverId, nonce) {
      return cryptoSign(
        null,
        Buffer.from(`${RELAY_OWNERSHIP_SIGNATURE_PREFIX}:${serverId}:${nonce}`, "utf8"),
        keys.privateKey,
      ).toString("base64url");
    },
    verify(nonce, signature) {
      return verify(
        null,
        Buffer.from(`${RELAY_OWNERSHIP_SIGNATURE_PREFIX}:srv_1:${nonce}`, "utf8"),
        createPublicKey({ format: "jwk", key: jwk }),
        Buffer.from(signature, "base64url"),
      );
    },
  };
}

const logger = pino({ level: "silent" });

describe("relay ownership guard", () => {
  test("answers relay_challenge with a verifiable relay_auth and hides auth frames", async () => {
    const socket = new FakeSocket();
    const signer = createSigner();
    const guard = createRelayOwnershipGuard(socket, signer, logger, "srv_1");

    const received: string[] = [];
    guard.on("message", (data) => received.push(String(data)));

    socket.emitMessage(JSON.stringify({ type: "relay_challenge", v: 1, nonce: "n-42" }));
    expect(socket.sent).toHaveLength(1);
    const auth = JSON.parse(socket.sent[0]!) as Record<string, unknown>;
    expect(auth.type).toBe("relay_auth");
    expect(auth.publicKey).toBe(signer.publicKeyB64url);
    expect(signer.verify("n-42", String(auth.signature))).toBe(true);
    expect(received).toEqual([]);

    socket.emitMessage(JSON.stringify({ type: "relay_auth_ok" }));
    expect(received).toEqual([]);

    socket.emitMessage('{"type":"next"}');
    expect(received).toEqual(['{"type":"next"}']);
  });

  test("rejects relays that send session traffic without challenging", () => {
    const socket = new FakeSocket();
    const guard = createRelayOwnershipGuard(socket, createSigner(), logger, "srv_1");

    const received: string[] = [];
    guard.on("message", (data) => received.push(String(data)));

    socket.emitMessage(JSON.stringify({ type: "sync", connectionIds: [] }));
    socket.emitMessage('{"type":"hello"}');
    expect(received).toEqual([]);
    expect(socket.closed).toEqual([{ code: 4401, reason: "Relay ownership preflight failed" }]);
    expect(socket.sent).toEqual([]);
  });

  test("outbound traffic cannot precede the ownership exchange", () => {
    const socket = new FakeSocket();
    const guard = createRelayOwnershipGuard(socket, createSigner(), logger, "srv_1");
    expect(() => guard.send("payload")).toThrow("Relay ownership is not authenticated");
    expect(socket.sent).toEqual([]);
    socket.emitMessage(JSON.stringify({ type: "relay_challenge", v: 1, nonce: "n-9" }));
    expect(() => guard.send("payload")).toThrow("Relay ownership is not authenticated");
    socket.emitMessage(JSON.stringify({ type: "relay_auth_ok" }));
    guard.send("payload");
    expect(socket.sent[1]).toBe("payload");
  });

  test("rejects premature traffic and forwards close to listeners", () => {
    const socket = new FakeSocket();
    const guard = createRelayOwnershipGuard(socket, createSigner(), logger, "srv_1");

    const received: string[] = [];
    guard.on("message", (data) => received.push(String(data)));
    let closed = 0;
    guard.on("close", () => {
      closed += 1;
    });

    socket.emitMessage(JSON.stringify({ type: "relay_challenge", v: 1, nonce: "n-9" }));
    socket.emitMessage('{"type":"premature"}');
    socket.emitClose();
    expect(received).toEqual([]);
    expect(closed).toBe(1);
  });
});
