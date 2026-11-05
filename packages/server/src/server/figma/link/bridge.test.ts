import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import type { FigmaLinkStatus } from "@jagentdesk/protocol/figma/rpc-schemas";
import { MemorySecretStore } from "../../database/secret-store.js";
import { FigmaServiceError } from "../context.js";
import { FigmaLinkServer } from "./bridge.js";
import { PAIRING_CODE_TTL_MS } from "./protocol.js";
import { FakePlugin } from "./test-support/fake-plugin.js";
import { describe, expect, it, vi } from "vitest";

// The bridge against a real loopback server and a fake plugin socket — no
// mocks of our own classes, no Figma, no network beyond 127.0.0.1. Each test
// binds its own ephemeral port so the suite never touches the dev daemon.

const logger = pino({ level: "silent" });

function linkState(status: FigmaLinkStatus): { paired: boolean; linked: boolean } {
  return { paired: status.files.some((file) => file.paired), linked: status.files.length > 0 };
}

function makeBridge(): {
  bridge: FigmaLinkServer;
  clock: { now: number };
  start: () => Promise<number>;
} {
  const clock = { now: 1_700_000_000_000 };
  const bridge = new FigmaLinkServer({
    secrets: new MemorySecretStore(),
    dataDir: mkdtempSync(path.join(tmpdir(), "jad-figma-link-")),
    logger,
    port: 0,
    now: () => clock.now,
    autoInstall: false,
  });
  return {
    bridge,
    clock,
    start: async () => {
      const started = await bridge.start();
      if (!started.ok) throw new Error("bridge failed to bind an ephemeral port");
      return started.port;
    },
  };
}

describe("FigmaLinkServer", () => {
  it("refuses tool calls until the pairing code is redeemed", async () => {
    const { bridge, start } = makeBridge();
    const port = await start();
    const plugin = new FakePlugin({ url: `ws://127.0.0.1:${port}/ws` });
    await plugin.connect();
    plugin.hello();

    const required = await plugin.nextFrame("pairing_required");
    expect(required.code).toMatch(/^\d{6}$/);

    await expect(bridge.callTool("fk-1", "get_document", {})).rejects.toMatchObject({
      code: "link_unpaired",
    });

    const status = await bridge.pair(String(required.code));
    expect(status.files).toHaveLength(1);
    expect(status.files[0]?.paired).toBe(true);

    const response = await bridge.callTool("fk-1", "get_node", { nodeIds: ["1:2"] });
    expect(response.ok).toBe(true);
    expect(plugin.requests.map((r) => r.toolName)).toEqual(["get_node"]);
    expect(plugin.requests[0]?.nodeIds).toEqual(["1:2"]);

    await plugin.close();
    await bridge.close();
  });

  it("rejects a wrong pairing key and falls back to pairing", async () => {
    const { bridge, start } = makeBridge();
    const port = await start();
    const plugin = new FakePlugin({
      url: `ws://127.0.0.1:${port}/ws`,
      pairingId: "pairing-1",
      pairingKey: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    });
    await plugin.connect();
    plugin.hello();

    await plugin.nextFrame("pairing_rejected");
    const required = await plugin.nextFrame("pairing_required");
    expect(required.code).toMatch(/^\d{6}$/);
    // The key never matched, so the connection is registered but unpaired.
    await expect(bridge.callTool("fk-1", "get_document", {})).rejects.toMatchObject({
      code: "link_unpaired",
    });
    expect(bridge.status().pendingPairing).not.toBeNull();

    await plugin.close();
    await bridge.close();
  });

  it("rejects a browser tab presenting an https Origin", async () => {
    const { bridge, start } = makeBridge();
    const port = await start();
    const plugin = new FakePlugin({ url: `ws://127.0.0.1:${port}/ws`, origin: "https://evil" });
    await plugin.connect();

    const rejected = await plugin.nextFrame("link_rejected");
    expect(rejected.reason).toBe("bad-origin");
    expect(await plugin.closed()).toBe(1008);

    await bridge.close();
  });

  it("expires a pairing code after its TTL", async () => {
    const { bridge, clock, start } = makeBridge();
    const port = await start();
    const plugin = new FakePlugin({ url: `ws://127.0.0.1:${port}/ws` });
    await plugin.connect();
    plugin.hello();
    const required = await plugin.nextFrame("pairing_required");

    clock.now += PAIRING_CODE_TTL_MS + 1;
    await expect(bridge.pair(String(required.code))).rejects.toMatchObject({
      code: "pairing_required",
    });
    expect(bridge.status().pendingPairing).toBeNull();

    await plugin.close();
    await bridge.close();
  });

  it("keeps a mismatched plugin version connected but blocked", async () => {
    const { bridge, start } = makeBridge();
    const port = await start();
    const plugin = new FakePlugin({ url: `ws://127.0.0.1:${port}/ws`, version: "0.9.0" });
    await plugin.connect();
    plugin.hello();

    const blocked = await plugin.nextFrame("link_blocked");
    expect(blocked.requiredVersion).toBe("1.0.0");
    expect(bridge.isLinked("fk-1")).toBe(false);
    await expect(bridge.callTool("fk-1", "get_node", {})).rejects.toMatchObject({
      code: "link_version_mismatch",
    });

    const status = bridge.status();
    expect(status.files).toHaveLength(1);
    expect(status.files[0]?.pluginVersion).toBe("0.9.0");

    await plugin.close();
    await bridge.close();
  });

  it("replaces the existing connection for a fileKey", async () => {
    const { bridge, start } = makeBridge();
    const port = await start();
    const first = new FakePlugin({ url: `ws://127.0.0.1:${port}/ws` });
    await first.connect();
    first.hello();
    await first.nextFrame("pairing_required");

    const second = new FakePlugin({ url: `ws://127.0.0.1:${port}/ws` });
    await second.connect();
    second.hello();
    await second.nextFrame("pairing_required");
    expect(await first.closed()).toBe(1000);
    expect(bridge.status().files).toHaveLength(1);

    await first.close();
    await second.close();
    await bridge.close();
  });

  it("pushes link status on connect, pairing and disconnect", async () => {
    const { bridge, start } = makeBridge();
    const port = await start();
    const pushes: Array<{ paired: boolean; linked: boolean }> = [];
    bridge.attachPush((status) => {
      pushes.push(linkState(status));
    });

    const plugin = new FakePlugin({ url: `ws://127.0.0.1:${port}/ws` });
    await plugin.connect();
    plugin.hello();
    const required = await plugin.nextFrame("pairing_required");
    expect(pushes.at(-1)).toEqual({ linked: true, paired: false });

    await bridge.pair(String(required.code));
    expect(pushes.at(-1)).toEqual({ linked: true, paired: true });

    plugin.pluginStatus({ currentPage: "Cover" });
    await vi.waitFor(() => expect(bridge.status().files[0]?.pageName).toBe("Cover"));

    await plugin.close();
    await vi.waitFor(() => expect(pushes.at(-1)).toEqual({ linked: false, paired: false }));
    await bridge.close();
  });

  it("reports port_in_use when another server holds the port", async () => {
    const { bridge, start } = makeBridge();
    const port = await start();
    const squatter = new FigmaLinkServer({
      secrets: new MemorySecretStore(),
      dataDir: mkdtempSync(path.join(tmpdir(), "jad-figma-link-")),
      logger,
      port,
      autoInstall: false,
    });
    const started = await squatter.start();
    expect(started).toEqual({ ok: false, error: "port_in_use" });
    expect(squatter.status().server).toBe("port_in_use");

    await bridge.close();
    await squatter.close();
  });

  it("throws link_unavailable when no plugin is connected", async () => {
    const { bridge, start } = makeBridge();
    await start();
    const error = await bridge.callTool("fk-x", "get_node", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FigmaServiceError);
    expect((error as FigmaServiceError).code).toBe("link_unavailable");
    await bridge.close();
  });
});
