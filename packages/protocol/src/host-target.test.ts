import { expect, test } from "vitest";
import { parseHostTarget } from "./host-target.js";
const link = (ip: string) =>
  `jagentdesk://pair#${Buffer.from(JSON.stringify({ v: 1, serverId: "srv_destination", host: "", ip, port: 8765, pk: "public-key" })).toString("base64url")}`;
test("daemon connectors admit paired loopback and tailnet paths only", () => {
  expect(parseHostTarget(link("127.0.0.1"))).toMatchObject({
    via: "local",
    url: "ws://127.0.0.1:8765/ws?paired=1",
  });
  expect(parseHostTarget(link("100.64.12.9"))).toMatchObject({ via: "tailnet" });
  for (const target of [
    "ssh://localhost",
    "ws://localhost",
    "tcp://localhost:8765",
    link("100.1.2.3"),
    link("192.168.1.2"),
    link("8.8.8.8"),
  ])
    expect(() => parseHostTarget(target)).toThrow("pairing link");
});
