import { afterEach, describe, expect, it } from "vitest";
import { generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { resetRelayOwnership } from "./relay.js";

const servers: WebSocketServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("relay reset", () => {
  it.each([1000, 4403])("signs the Worker challenge and handles close %s", async (closeCode) => {
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ format: "jwk" }).x!;
    const nonce = randomBytes(32).toString("base64url");
    const serverId = "srv_cli_reset";
    const message = `jagentdesk-relay-v1:${serverId}:${nonce}`;
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    servers.push(server);
    await once(server, "listening");
    const address = server.address();
    if (typeof address === "string" || !address) throw new Error("Missing port");
    let signatureValid = false;
    let requestUrl: URL | undefined;
    const handleAuth = (socket: import("ws").WebSocket, raw: import("ws").RawData) => {
      const auth = JSON.parse(raw.toString());
      signatureValid =
        auth.type === "relay_auth" &&
        auth.publicKey === publicKey &&
        verify(
          null,
          Buffer.from(message),
          keys.publicKey,
          Buffer.from(auth.signature, "base64url"),
        );
      socket.close(signatureValid ? closeCode : 4403);
    };
    server.on("connection", (socket, request) => {
      requestUrl = new URL(request.url!, "http://127.0.0.1");
      socket.send(JSON.stringify({ type: "relay_challenge", v: 1, nonce }));
      socket.on("message", handleAuth.bind(undefined, socket));
    });
    const reset = resetRelayOwnership({
      endpoint: `127.0.0.1:${address.port}`,
      useTls: false,
      serverId,
      signer: {
        publicKeyB64url: publicKey,
        signOwnership: (id, challenge) =>
          sign(
            null,
            Buffer.from(`jagentdesk-relay-v1:${id}:${challenge}`),
            keys.privateKey,
          ).toString("base64url"),
      },
    });
    if (closeCode === 1000) await expect(reset).resolves.toBeUndefined();
    else await expect(reset).rejects.toThrow("4403");
    expect(signatureValid).toBe(true);
    expect(requestUrl?.searchParams.get("role")).toBe("server");
    expect(requestUrl?.searchParams.get("reset")).toBe("1");
    expect(requestUrl?.searchParams.has("connectionId")).toBe(false);
  });

  it("times out when the relay never sends a challenge", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    servers.push(server);
    await once(server, "listening");
    const address = server.address();
    if (typeof address === "string" || !address) throw new Error("Missing port");
    await expect(
      resetRelayOwnership({
        endpoint: `127.0.0.1:${address.port}`,
        useTls: false,
        serverId: "srv_timeout",
        timeoutMs: 50,
        signer: {
          publicKeyB64url: "unused",
          signOwnership: () => {
            throw new Error("No challenge");
          },
        },
      }),
    ).rejects.toThrow("timed out");
  });
});
