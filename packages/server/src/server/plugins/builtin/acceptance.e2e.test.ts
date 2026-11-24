import { HostCapabilityService } from "../../host-capabilities/service.js";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import pino from "pino";
import { WebSocket } from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  BUILTIN_PLUGIN_IDS,
  type BuiltinPluginListItem,
} from "@jagentdesk/protocol/builtin-plugins";
import { DaemonClient } from "../../test-utils/daemon-client.js";
import {
  createTestJAgentDeskDaemon,
  type TestJAgentDeskDaemon,
} from "../../test-utils/jagentdesk-daemon.js";
import { TunnelManager, type TunnelHandle } from "../../session-share/tunnel-manager.js";

// A local transport adapter: the real scoped ShareServer and real guest sessions use loopback.
// No Cloudflare account or public tunnel is needed to verify revocation.
class LoopbackTunnel extends TunnelManager {
  stopped = 0;
  override async start(port: number): Promise<TunnelHandle> {
    return {
      url: `http://127.0.0.1:${port}`,
      stop: async () => {
        this.stopped++;
      },
    };
  }
}
let daemon: TestJAgentDeskDaemon;
let client: DaemonClient;
const tunnel = new LoopbackTunnel(pino({ level: "silent" }));
const errorLogs: string[] = [];
beforeAll(async () => {
  daemon = await createTestJAgentDeskDaemon({
    sessionShareTunnelManager: tunnel,
    logger: pino({ level: "error" }, { write: (line) => errorLogs.push(line) }),
  });
  client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.9.59" });
  await client.connect();
}, 60_000);
afterAll(async () => {
  await client?.close();
  await daemon?.close();
});

async function tools(agentId: string): Promise<string[]> {
  const mcp = new Client({ name: "builtin-acceptance", version: "1" });
  try {
    await mcp.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${daemon.port}/mcp/agents?callerAgentId=${agentId}`),
      ),
    );
    return (await mcp.listTools()).tools.map(({ name }) => name);
  } finally {
    await mcp.close();
  }
}
async function agent() {
  return daemon.daemon.agentManager.createAgent(
    { provider: "codex", cwd: daemon.jagentdeskHome },
    undefined,
    {},
  );
}

test("36.6 #1: a new host exposes the 20 static and six bundled built-ins independently of Installed", async () => {
  const state = await client.getBuiltinPluginState();
  expect(state.canManage).toBe(true);
  expect(state.plugins.map(({ id }) => id)).toEqual(BUILTIN_PLUGIN_IDS);
  expect(state.plugins.filter(({ enabled }) => enabled)).toHaveLength(20);
  expect(state.plugins.filter(({ enabled }) => !enabled).map(({ id }) => id)).toEqual([
    "autorun",
    "session-share",
    "browser-tools",
    "hoplite-provider",
    "fx-provider",
    "goose-provider",
  ]);
  await client.patchDaemonConfig({ pluginsEnabled: false });
  expect((await client.listBuiltinPlugins()).filter(({ enabled }) => enabled)).toHaveLength(20);
});

test("36.6 #2: Docker RPCs and new agent catalogs change live; old agents retain their tools", async () => {
  const before = await agent();
  expect((await tools(before.id)).some((name) => name.startsWith("docker_"))).toBe(true);
  const errorsBefore = errorLogs.length;
  await client.setBuiltinPlugin("docker", false);
  await expect(client.dockerList()).rejects.toMatchObject({ code: "plugin_disabled" });
  expect(errorLogs).toHaveLength(errorsBefore);
  const after = await agent();
  expect((await tools(after.id)).filter((name) => name.startsWith("docker_"))).toEqual([]);
  expect((await tools(before.id)).some((name) => name.startsWith("docker_"))).toBe(true);
  await client.setBuiltinPlugin("docker", true);
  expect((await tools(after.id)).filter((name) => name.startsWith("docker_"))).toEqual([]);
  const reenabled = await agent();
  expect((await tools(reenabled.id)).some((name) => name.startsWith("docker_"))).toBe(true);
});

test("Forge Hub toggles preserve B9 core worktree discovery and per-agent tool catalogs", async () => {
  const repo = path.join(daemon.jagentdeskHome, "core-worktree-discovery");
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "pipe" });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=JAgentDesk Test",
      "-c",
      "user.email=test@jagentdesk.local",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "initial",
    ],
    { cwd: repo, stdio: "pipe" },
  );
  const before = await agent();
  expect((await tools(before.id)).some((name) => name.startsWith("forge_"))).toBe(true);
  await client.setBuiltinPlugin("forge-hub", false);
  try {
    await expect(client.forgeListConnections()).rejects.toMatchObject({ code: "plugin_disabled" });
    await writeFile(path.join(repo, "scratch.txt"), "discard me\n");
    expect(await client.checkoutDiscardChanges(repo, { paths: ["scratch.txt"] })).toMatchObject({
      success: true,
      error: null,
    });
    await expect(readFile(path.join(repo, "scratch.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await client.listCheckoutWorktrees(repo)).toEqual(
      expect.arrayContaining([expect.objectContaining({ branchName: "main", containsCwd: true })]),
    );
    const after = await agent();
    expect((await tools(after.id)).filter((name) => name.startsWith("forge_"))).toEqual([]);
    expect((await tools(before.id)).some((name) => name.startsWith("forge_"))).toBe(true);
  } finally {
    await client.setBuiltinPlugin("forge-hub", true);
  }
});

test("36.6 #3: declining a cascade leaves SSH and Remote tasks unchanged; accepting changes both", async () => {
  await expect(client.setBuiltinPlugin("ssh-servers", false)).rejects.toMatchObject({
    code: "plugin_dependency",
  });
  expect(
    (await client.listBuiltinPlugins())
      .filter(({ id }) => id === "ssh-servers" || id === "remote-tasks")
      .map(({ enabled }) => enabled),
  ).toEqual([true, true]);
  const pushed: string[] = [];
  const unsubscribe = client.on("plugins.builtin.changed", ({ payload }) => {
    pushed.push(...payload.plugins.filter(({ enabled }) => !enabled).map(({ id }) => id));
  });
  try {
    await client.setBuiltinPlugin("ssh-servers", false, true);
    expect(
      (await client.listBuiltinPlugins())
        .filter(({ id }) => id === "ssh-servers" || id === "remote-tasks")
        .map(({ enabled }) => enabled),
    ).toEqual([false, false]);
    await expect.poll(() => pushed.includes("remote-tasks")).toBe(true);
    await client.setBuiltinPlugin("remote-tasks", true, true);
  } finally {
    unsubscribe();
  }
});

test("36.6 #4: persisted toggles survive restart and legacy browser settings migrate once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jad-builtin-restart-"));
  const home = path.join(root, ".jagentdesk");
  await mkdir(home);
  await writeFile(
    path.join(home, "config.json"),
    JSON.stringify({ daemon: { browserTools: { enabled: true } } }),
  );
  let host: TestJAgentDeskDaemon | undefined;
  let connection: DaemonClient | undefined;
  try {
    host = await createTestJAgentDeskDaemon({ jagentdeskHomeRoot: root, cleanup: false });
    connection = new DaemonClient({ url: `ws://127.0.0.1:${host.port}/ws`, appVersion: "0.9.59" });
    await connection.connect();
    expect(
      (await connection.listBuiltinPlugins()).find(({ id }) => id === "browser-tools")?.enabled,
    ).toBe(true);
    await connection.setBuiltinPlugin("docker", false);
    await connection.close();
    await host.close();
    host = await createTestJAgentDeskDaemon({ jagentdeskHomeRoot: root, cleanup: false });
    connection = new DaemonClient({ url: `ws://127.0.0.1:${host.port}/ws`, appVersion: "0.9.59" });
    await connection.connect();
    const list = await connection.listBuiltinPlugins();
    expect(list.find(({ id }) => id === "docker")?.enabled).toBe(false);
    expect(list.find(({ id }) => id === "browser-tools")?.enabled).toBe(true);
    const persisted = JSON.parse(await readFile(path.join(home, "config.json"), "utf8"));
    expect(persisted.builtinPlugins.docker).toEqual({ enabled: false });
  } finally {
    await connection?.close();
    await host?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("36.6 #5: an older app receives live false Figma server-info flags", async () => {
  const old = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  await old.connect();
  try {
    expect(old.getLastServerInfoMessage()?.features?.figma).toBe(true);
    await client.setBuiltinPlugin("figma", false);
    await expect.poll(() => old.getLastServerInfoMessage()?.features?.figma).toBe(false);
    expect(old.getLastServerInfoMessage()?.features?.figmaRemoteWrites).toBe(false);
    await client.setBuiltinPlugin("figma", true);
    await expect.poll(() => old.getLastServerInfoMessage()?.features?.figma).toBe(true);
  } finally {
    await old.close();
  }
});

test("36.6 #6: turning sharing off disconnects real scoped guests and stops the tunnel", async () => {
  await client.setBuiltinPlugin("session-share", true);
  const shared = await agent();
  const share = await client.sessionShareCreate(shared.id, { capabilities: { readOnly: true } });
  const origin = share.tunnelUrl!;
  const pairing = new WebSocket(`${origin.replace("http:", "ws:")}/guest`);
  const frames: Record<string, unknown>[] = [];
  pairing.on("message", (data) => {
    frames.push(JSON.parse(data.toString()));
  });
  await once(pairing, "open");
  pairing.send(JSON.stringify({ t: "request", name: "Scoped guest" }));
  await expect
    .poll(async () => (await client.sessionShareList())[0]?.pendingRequests.length)
    .toBe(1);
  const pending = (await client.sessionShareList())[0]!.pendingRequests[0]!;
  const approved = await client.sessionShareRespond(share.shareId, pending.requestId, true);
  pairing.send(JSON.stringify({ t: "pair", code: approved.pendingRequests[0]!.code }));
  await expect
    .poll(() => frames.some((frame) => frame.t === "pair_result" && frame.ok === true))
    .toBe(true);
  const token = frames.find((frame) => frame.t === "pair_result" && frame.ok === true)!
    .guestToken as string;
  const guest = new DaemonClient({
    url: `${origin.replace("http:", "ws:")}/ws`,
    appVersion: "0.9.59",
    password: token,
    reconnect: { enabled: false },
  });
  await guest.connect();
  try {
    await expect(guest.setBuiltinPlugin("docker", false)).rejects.toMatchObject({
      code: "access_denied",
    });
    const changed: string[] = [];
    const unsubscribe = guest.on("plugins.builtin.changed", () => {
      changed.push("changed");
    });
    const unsubscribeConfig = guest.on("status", ({ payload }) => {
      if (payload.status === "daemon_config_changed") changed.push("config");
    });
    const closed = once(pairing, "close");
    const started = performance.now();
    await client.setBuiltinPlugin("session-share", false);
    await closed;
    expect(performance.now() - started).toBeLessThan(5_000);
    await expect.poll(() => guest.getConnectionState().status).not.toBe("connected");
    expect(tunnel.stopped).toBe(1);
    expect(changed).toEqual([]);
    await expect(client.sessionShareList()).rejects.toMatchObject({ code: "plugin_disabled" });
    unsubscribe();
    unsubscribeConfig();
  } finally {
    pairing.terminate();
    await guest.close();
  }
}, 30_000);

test("probing Devices stays pending and settling probes pushes built-in availability to clients", async () => {
  let settle!: () => void;
  const gate = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const capabilities = new HostCapabilityService({
    jagentdeskHome: daemon.jagentdeskHome,
    logger: pino({ level: "silent" }),
    host: {
      platform: "linux",
      arch: "x64",
      env: {},
      homeDir: daemon.jagentdeskHome,
      jagentdeskHome: daemon.jagentdeskHome,
      exists: () => false,
    },
    runner: {
      find: async () => {
        await gate;
        return null;
      },
      run: async () => ({ ok: false, stdout: "", stderr: "" }),
    },
  });
  const host = await createTestJAgentDeskDaemon({ hostCapabilities: capabilities });
  const connection = new DaemonClient({
    url: `ws://127.0.0.1:${host.port}/ws`,
    appVersion: "0.9.59",
  });
  const pushed: BuiltinPluginListItem[][] = [];
  const devicesUnavailable = () =>
    pushed.at(-1)?.find(({ id }) => id === "devices")?.available === false;
  try {
    await connection.connect();
    const pending = (await connection.listBuiltinPlugins()).find(({ id }) => id === "devices")!;
    expect(pending.available).toBe(true);
    expect(pending.unavailableReason).toBeUndefined();
    const unsubscribe = connection.on("plugins.builtin.changed", ({ payload }) =>
      pushed.push(payload.plugins),
    );
    // Flush the client's event-demand update before allowing the probes to finish.
    await connection.listBuiltinPlugins();
    settle();
    await capabilities.refresh();
    await expect.poll(devicesUnavailable).toBe(true);
    expect(pushed.at(-1)?.find(({ id }) => id === "devices")?.unavailableReason).toContain("adb");
    expect(
      (await connection.listBuiltinPlugins()).find(({ id }) => id === "workbench")?.available,
    ).toBe(false);
    unsubscribe();
  } finally {
    settle();
    await connection.close();
    await host.close();
  }
});
