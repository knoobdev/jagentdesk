import { expect, test } from "vitest";
import pino from "pino";
import { once } from "node:events";
import { WebSocket } from "ws";
import { DaemonClient } from "./test-utils/daemon-client.js";
import { createTestJAgentDeskDaemon } from "./test-utils/jagentdesk-daemon.js";

test("rapid built-in toggles survive disconnect during delivery and the same client ID resumes with pushes", async () => {
  const logs: string[] = [];
  const daemon = await createTestJAgentDeskDaemon({
    logger: pino({ level: "debug" }, { write: (line) => logs.push(line) }),
  });
  const clients: DaemonClient[] = [];
  const url = `ws://127.0.0.1:${daemon.port}/ws`;
  const control = new DaemonClient({ url, appVersion: "0.9.59" });
  clients.push(control);
  try {
    await control.connect();
    for (let index = 0; index < 3; index++) {
      let socket!: WebSocket;
      const client = new DaemonClient({
        url,
        clientId: "reloaded-browser",
        appVersion: "0.9.59",
        reconnect: { enabled: false },
        onWebSocket: (connected) => {
          socket = connected;
        },
      });
      clients.push(client);
      await client.connect();
      await client.observeEvents(["status.daemon_config_changed"]).ready;
      const disconnected = once(socket, "close");
      if (index === 0) {
        // Hold the close handshake open so the daemon sees a closing source before detach.
        socket.pause();
        socket.close();
        await control.ping({ requestId: "closing-source-barrier" });
      } else {
        const stop = client.on("plugins.builtin.changed", () => {
          stop();
          socket.terminate();
        });
      }
      const off = control.setBuiltinPlugin("docker", false);
      const on = control.setBuiltinPlugin("docker", true);
      try {
        await Promise.all([off, on]);
      } finally {
        socket.resume();
      }
      await disconnected;
      await client.close();
    }
    const replacement = new DaemonClient({
      url,
      clientId: "reloaded-browser",
      appVersion: "0.9.59",
    });
    clients.push(replacement);
    await replacement.connect();
    const pushed: boolean[] = [];
    replacement.on("plugins.builtin.changed", ({ payload }) => {
      const docker = payload.plugins.find(({ id }) => id === "docker");
      if (docker && pushed.at(-1) !== docker.enabled) pushed.push(docker.enabled);
    });
    await control.setBuiltinPlugin("docker", false);
    await control.setBuiltinPlugin("docker", true);
    await expect.poll(() => pushed).toEqual([false, true]);
    await replacement.ping({ requestId: "daemon-still-alive" });
    const records = logs.map((line) => JSON.parse(line));
    const resumedSessions = records.filter(
      (entry) =>
        entry.msg === "Client connected via hello" && entry.clientId === "reloaded-browser",
    );
    expect(new Set(resumedSessions.map((entry) => entry.sessionId)).size).toBe(1);
    expect(resumedSessions.map((entry) => entry.resumed)).toEqual([false, true, true, true]);
    expect(
      records.some(
        (entry) =>
          entry.msg === "Failed to emit source frame" &&
          entry.err?.message === "Source message delivery unavailable",
      ),
    ).toBe(true);
    expect(records.filter((entry) => entry.level >= 50)).toEqual([]);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await daemon.close();
  }
}, 60_000);
