import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { DEFAULT_RELAY_ENDPOINT, loadConfig } from "./config.js";

const roots: string[] = [];

async function createJAgentDeskHome(config: unknown): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "jagentdesk-config-relay-"));
  roots.push(root);
  const jagentdeskHome = path.join(root, ".jagentdesk");
  await mkdir(jagentdeskHome, { recursive: true });
  await writeFile(path.join(jagentdeskHome, "config.json"), JSON.stringify(config, null, 2));
  return jagentdeskHome;
}

describe("daemon relay config (spec 35.3)", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("relay ships enabled by default with the hosted endpoint", async () => {
    const home = await createJAgentDeskHome({ version: 1 });
    const config = loadConfig(home, { env: {} });
    expect(config.relayEnabled).toBe(true);
    expect(config.relayEndpoint).toBe(DEFAULT_RELAY_ENDPOINT);
    expect(config.relayUseTls).toBe(true);
    expect(config.relayEnabledMutable).toBe(true);
  });

  test("keeps explicit persisted relay state and marks it mutable", async () => {
    const home = await createJAgentDeskHome({
      version: 1,
      daemon: { relay: { enabled: false } },
    });
    const config = loadConfig(home, { env: {} });
    expect(config.relayEnabled).toBe(false);
    expect(config.relayEnabledMutable).toBe(true);
  });

  test("persisted endpoint and TLS win over defaults", async () => {
    const home = await createJAgentDeskHome({
      version: 1,
      daemon: { relay: { endpoint: "relay.example.com:8443", useTls: false } },
    });
    const config = loadConfig(home, { env: {} });
    expect(config.relayEndpoint).toBe("relay.example.com:8443");
    expect(config.relayUseTls).toBe(false);
  });

  test("marks environment relay overrides immutable", async () => {
    const home = await createJAgentDeskHome({
      version: 1,
      daemon: { relay: { enabled: false } },
    });
    const config = loadConfig(home, { env: { JAGENTDESK_RELAY_ENABLED: "true" } });
    expect(config.relayEnabled).toBe(true);
    expect(config.relayEnabledMutable).toBe(false);
  });

  test.each(["", "treu"])(
    "ignores invalid relay override %j without locking config",
    async (value) => {
      const home = await createJAgentDeskHome({
        version: 1,
        daemon: { relay: { enabled: false } },
      });
      const config = loadConfig(home, { env: { JAGENTDESK_RELAY_ENABLED: value } });
      expect(config.relayEnabled).toBe(false);
      expect(config.relayEnabledMutable).toBe(true);
    },
  );

  test("environment endpoint and TLS override persisted values", async () => {
    const home = await createJAgentDeskHome({
      version: 1,
      daemon: { relay: { endpoint: "persisted.example.com", useTls: true } },
    });
    const config = loadConfig(home, {
      env: { JAGENTDESK_RELAY_ENDPOINT: "env.example.com:443", JAGENTDESK_RELAY_USE_TLS: "false" },
    });
    expect(config.relayEndpoint).toBe("env.example.com:443");
    expect(config.relayUseTls).toBe(false);
  });
});
