import { afterEach, expect, test } from "vitest";
import { DaemonClient, type DaemonTransport } from "./daemon-client";

function challengeTransport() {
  const sent: string[] = [];
  let onMessage: (data: unknown) => void = () => {};
  let onOpen: () => void = () => {};
  const transport: DaemonTransport = {
    send: (data) => {
      if (typeof data === "string") sent.push(data);
    },
    close: () => {},
    onMessage: (handler) => {
      onMessage = handler;
      return () => {};
    },
    onOpen: (handler) => {
      onOpen = handler;
      return () => {};
    },
    onClose: () => () => {},
    onError: () => () => {},
  };
  return {
    transport,
    sent,
    open: () => onOpen(),
    challenge: (nonce: string) => onMessage(JSON.stringify({ type: "challenge", nonce })),
  };
}

const clients: DaemonClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
});

function signedClient(
  mock: ReturnType<typeof challengeTransport>,
  signNonce: (nonce: string) => string | Promise<string>,
) {
  const client = new DaemonClient({
    url: "ws://relay-test/ws",
    clientId: "stage_test",
    transportFactory: () => mock.transport,
    reconnect: { enabled: false },
    expectChallenge: true,
    deviceSigning: { devicePublicKeyB64: "cHVibGlj", signNonce },
  });
  clients.push(client);
  return client;
}

test("connectStage follows the attempt from socket to signed hello", () => {
  const mock = challengeTransport();
  const client = signedClient(mock, (nonce) => `signed:${nonce}`);
  void client.connect().catch(() => undefined);
  expect(client.connectStage).toBe("connecting");
  mock.open();
  expect(client.connectStage).toBe("opened");
  mock.challenge("nonce-1");
  expect(client.connectStage).toBe("hello_sent");
  expect(JSON.parse(mock.sent.at(-1)!)).toMatchObject({
    type: "hello",
    nonce: "nonce-1",
    signature: "signed:nonce-1",
    devicePublicKeyB64: "cHVibGlj",
  });
});

test("a signer that never answers leaves the attempt at signing", () => {
  const mock = challengeTransport();
  const client = signedClient(mock, () => new Promise<string>(() => {}));
  void client.connect().catch(() => undefined);
  mock.open();
  mock.challenge("nonce-2");
  expect(client.connectStage).toBe("signing");
  expect(mock.sent.some((frame) => frame.includes('"type":"hello"'))).toBe(false);
});

test("an empty signature fails the attempt with that reason instead of an unsigned hello", async () => {
  const mock = challengeTransport();
  const client = signedClient(mock, () => "");
  const connecting = client.connect();
  mock.open();
  mock.challenge("nonce-3");
  await expect(connecting).rejects.toThrow("This device's key returned an empty signature");
  expect(mock.sent.some((frame) => frame.includes('"type":"hello"'))).toBe(false);
});
