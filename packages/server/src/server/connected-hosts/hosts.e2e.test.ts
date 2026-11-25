import { afterAll, beforeAll, expect, test } from "vitest";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createJAgentDeskApi } from "@jagentdesk/client";
import {
  createTestJAgentDeskDaemon,
  type TestJAgentDeskDaemon,
} from "../test-utils/jagentdesk-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";

let a: TestJAgentDeskDaemon, b: TestJAgentDeskDaemon, ca: DaemonClient, cb: DaemonClient;
beforeAll(async () => {
  a = await createTestJAgentDeskDaemon();
  b = await createTestJAgentDeskDaemon();
  ca = new DaemonClient({
    url: `ws://127.0.0.1:${a.port}/ws`,
    appVersion: "0.9.59",
    reconnect: { enabled: false },
  });
  cb = new DaemonClient({
    url: `ws://127.0.0.1:${b.port}/ws`,
    appVersion: "0.9.59",
    reconnect: { enabled: false },
  });
  await ca.connect();
  await cb.connect();
}, 60000);
afterAll(async () => {
  await ca?.close();
  await cb?.close();
  await a?.close();
  await b?.close();
}, 30000);

test("two-sided SAS admits a daemon key, keeps it private, routes under grants and revokes the link", async () => {
  const offer = await cb.beginSasPairing();
  let bCode: string | undefined;
  const stop = cb.subscribeRawMessages((message) => {
    if (message.type === "pairing.sas.changed") bCode = message.payload.code;
  });
  const pairing = await ca.beginHostPairing({ connection: offer.link, label: "B" });
  await expect.poll(() => bCode).toBe(pairing.code);
  expect((await ca.listHosts()).hosts).toEqual([]);
  await cb.confirmSasPairing(offer.pk, true);
  const host = await ca.confirmHostPairing(pairing.transactionId, true);
  stop();
  await expect.poll(async () => (await ca.listHosts()).hosts[0]?.status).toBe("connected");
  const disk = JSON.parse(await readFile(join(a.jagentdeskHome, "hosts.json"), "utf8"));
  expect((await stat(join(a.jagentdeskHome, "hosts.json"))).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(await ca.listHosts())).not.toContain(disk[0].credential.secretKey);
  const devices = await cb.pairingDeviceList();
  expect(devices.devices).toContainEqual(expect.objectContaining({ kind: "daemon" }));
  const api = createJAgentDeskApi(ca);
  const remote = await api.hosts.client(host.serverId!);
  expect(await remote.workspaces.list()).toMatchObject({ entries: [] });
  await expect(remote.hosts.list()).rejects.toMatchObject({ code: "unsupported_capability" });
  expect((await cb.listHosts()).hosts).toEqual([]);
  await remote.dispose();
  const limited = new DaemonClient({
    url: `ws://127.0.0.1:${a.port}/ws`,
    sessionPermissions: ["daemon.read"],
    reconnect: { enabled: false },
  });
  const limitedApi = createJAgentDeskApi(limited);
  try {
    await limited.connect();
    await expect(limited.updateHost(host.registrationId, { enabled: false })).rejects.toMatchObject(
      { code: "access_denied" },
    );
    const routed = await limitedApi.hosts.client(host.serverId!);
    await expect(routed.workspaces.list()).rejects.toMatchObject({ code: "access_denied" });
    await routed.dispose();
  } finally {
    await limitedApi.dispose();
    await limited.close();
  }
  await cb.pairingDeviceRevoke(devices.devices.find((d) => d.kind === "daemon")!.deviceId);
  await expect
    .poll(async () => (await ca.listHosts()).hosts[0]?.status, { timeout: 10000 })
    .toBe("error");
  await expect(api.hosts.client(host.serverId!)).rejects.toThrow();
  await ca.removeHost(host.registrationId);
  expect(JSON.parse(await readFile(join(a.jagentdeskHome, "hosts.json"), "utf8"))).toEqual([]);
  await api.dispose();
}, 45000);
