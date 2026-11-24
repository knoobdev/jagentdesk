import { expect, test } from "vitest";
import { DaemonClient } from "./test-utils/daemon-client.js";
import { createTestJAgentDeskDaemon } from "./test-utils/jagentdesk-daemon.js";

test("server_info always advertises terminal restore modes for released JAgentDesk apps", async () => {
  const daemon = await createTestJAgentDeskDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    // ADR-0051: v0.9.x apps omit restore unless this permanent flag is true.
    expect(client.getLastServerInfoMessage()?.features?.["terminal-restore-modes"]).toBe(true);
  } finally {
    await client.close();
    await daemon.close();
  }
});

test("isolates capable and released terminal viewers sharing a logical client ID", async () => {
  const { decodeTerminalStreamFrame, TerminalStreamOpcode } =
    await import("@jagentdesk/protocol/binary-frames/index");
  const daemon = await createTestJAgentDeskDaemon();
  const frames: Array<Array<ReturnType<typeof decodeTerminalStreamFrame>>> = [[], []];
  const clients = [true, false].map(
    (chunked, index) =>
      new DaemonClient({
        url: `ws://127.0.0.1:${daemon.port}/ws`,
        clientId: "terminal-shared-client",
        capabilities: { terminal_chunked_replay: chunked },
        onWebSocket: (socket) =>
          socket.on("message", (data, binary) => {
            if (binary)
              frames[index].push(decodeTerminalStreamFrame(new Uint8Array(data as Buffer)));
          }),
      }),
  );
  try {
    const terminal = await daemon.daemon.terminalManager.createTerminal({
      workspaceId: "terminal-replay-test",
      cwd: daemon.jagentdeskHome,
      rows: 6,
      cols: 80,
      command: process.execPath,
      args: ["-e", 'process.stdout.write("retained-screen\\r\\n");setInterval(()=>{},1000)'],
    });
    await Promise.all(clients.map((client) => client.connect()));
    await clients[0].subscribeTerminal(terminal.id, {
      restore: { mode: "visible-snapshot", scrollbackLines: 10000 },
    });
    await expect
      .poll(() => frames[0].some((frame) => frame?.opcode === TerminalStreamOpcode.ReplayEnd))
      .toBe(true);
    await clients[1].subscribeTerminal(terminal.id, { restore: { mode: "visible-snapshot" } });
    await expect
      .poll(() => frames[1].some((frame) => frame?.opcode === TerminalStreamOpcode.Restore))
      .toBe(true);
    expect(
      frames[1].filter((frame) => frame?.opcode === TerminalStreamOpcode.Restore),
    ).toHaveLength(1);
    expect(
      frames[1].some((frame) => frame && frame.opcode >= TerminalStreamOpcode.ReplayBegin),
    ).toBe(false);
    expect(frames[0].some((frame) => frame?.opcode === TerminalStreamOpcode.Restore)).toBe(false);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await daemon.close();
  }
});
