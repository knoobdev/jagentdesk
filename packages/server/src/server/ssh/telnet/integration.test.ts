import { describe, expect, it } from "vitest";
import { createConnection, createServer, type AddressInfo, type Server } from "node:net";
import type { Socket } from "node:net";
import {
  TelnetCommand,
  TelnetOption,
  TTYPE_IS,
  createTelnetStreamParser,
  encodeNaws,
  encodeTelnetCommand,
  encodeTelnetSubnegotiation,
  type TelnetSequence,
} from "./iac.js";
import { TelnetConnectionError, createTelnetTerminalSession } from "./terminal-session.js";

const TELNETD_PORT = 2323;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeTwoLinesThenDestroy(socket: Socket): void {
  socket.write(new TextEncoder().encode("first\r\nsecond\r\n"));
  setTimeout(() => socket.destroy(), 100);
}

function rowText(row: Array<{ char: string }>): string {
  return row
    .map((cell) => cell.char)
    .join("")
    .trimEnd();
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await delay(20);
  }
}

function isTelnetdReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createConnection({ host: "127.0.0.1", port: TELNETD_PORT });
    const finish = (value: boolean): void => {
      probe.destroy();
      resolve(value);
    };
    probe.setTimeout(1_000);
    probe.once("connect", () => finish(true));
    probe.once("timeout", () => finish(false));
    probe.once("error", () => finish(false));
  });
}

interface FakeTelnetServer {
  port: number;
  received: () => Uint8Array;
  receivedText: () => string;
  clientSequences: () => TelnetSequence[];
  close: () => Promise<void>;
}

async function startFakeTelnetServer(
  onConnection?: (socket: Socket) => void,
): Promise<FakeTelnetServer> {
  const received: number[] = [];
  const sockets: Socket[] = [];
  const server: Server = createServer((socket) => {
    sockets.push(socket);
    socket.on("data", (chunk: Buffer) => {
      received.push(...chunk);
    });
    onConnection?.(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const info = server.address();
  if (!info || typeof info === "string") {
    throw new Error("fake telnet server did not report an address");
  }
  return {
    port: (info as AddressInfo).port,
    received: () => Uint8Array.from(received),
    receivedText: () => Buffer.from(received).toString("utf8"),
    clientSequences: () => {
      const parsed = createTelnetStreamParser().push(Uint8Array.from(received));
      return parsed.sequences;
    },
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

const telnetdReachable = await isTelnetdReachable();

describe("TelnetTerminalSession against a fake server", () => {
  it("sends the initial WILL SGA/ECHO/NAWS/TTYPE then NAWS with the session size", async () => {
    const server = await startFakeTelnetServer();
    try {
      const session = await createTelnetTerminalSession({
        address: "127.0.0.1",
        port: server.port,
        cols: 100,
        rows: 30,
      });
      const expected = Uint8Array.from([
        ...Array.from(encodeTelnetCommand(TelnetCommand.WILL, TelnetOption.SGA)),
        ...Array.from(encodeTelnetCommand(TelnetCommand.WILL, TelnetOption.ECHO)),
        ...Array.from(encodeTelnetCommand(TelnetCommand.WILL, TelnetOption.NAWS)),
        ...Array.from(encodeTelnetCommand(TelnetCommand.WILL, TelnetOption.TTYPE)),
        ...Array.from(encodeNaws(100, 30)),
      ]);
      expect(Array.from(server.received())).toEqual(Array.from(expected));
      session.kill();
      await session.killAndWait();
    } finally {
      await server.close();
    }
  });

  it("answers WILL/DO per policy and replies TTYPE IS to TTYPE SEND", async () => {
    const server = await startFakeTelnetServer((socket) => {
      socket.write(
        Uint8Array.from([
          ...Array.from(encodeTelnetCommand(TelnetCommand.WILL, TelnetOption.ECHO)),
          ...Array.from(encodeTelnetCommand(TelnetCommand.WILL, TelnetOption.SGA)),
          ...Array.from(encodeTelnetCommand(TelnetCommand.WILL, 5)),
          ...Array.from(encodeTelnetCommand(TelnetCommand.DO, 5)),
          ...Array.from(encodeTelnetCommand(TelnetCommand.DO, TelnetOption.TTYPE)),
          ...Array.from(encodeTelnetSubnegotiation(TelnetOption.TTYPE, Uint8Array.from([1]))),
        ]),
      );
    });
    try {
      const session = await createTelnetTerminalSession({
        address: "127.0.0.1",
        port: server.port,
        cols: 80,
        rows: 24,
      });
      const willEcho = {
        kind: "command",
        command: TelnetCommand.WILL,
        option: TelnetOption.ECHO,
      } as const;
      const sequences = await waitForSequences(server, 11);
      expect(sequences.slice(5)).toEqual([
        { kind: "command", command: TelnetCommand.DO, option: TelnetOption.ECHO },
        { kind: "command", command: TelnetCommand.DO, option: TelnetOption.SGA },
        { kind: "command", command: TelnetCommand.WONT, option: 5 },
        { kind: "command", command: TelnetCommand.WONT, option: 5 },
        { kind: "command", command: TelnetCommand.WILL, option: TelnetOption.TTYPE },
        {
          kind: "sub",
          option: TelnetOption.TTYPE,
          data: Uint8Array.from([TTYPE_IS, ...new TextEncoder().encode("xterm-256color")]),
        },
      ]);
      expect(sequences).toHaveLength(11);
      // The DO for ECHO was accepted with WILL by the initial exchange too.
      expect(sequences[1]).toEqual(willEcho);
      session.kill();
      await session.killAndWait();
    } finally {
      await server.close();
    }
  });

  it("does not counter-propose when the server sends DONT/WONT", async () => {
    const server = await startFakeTelnetServer((socket) => {
      socket.write(
        Uint8Array.from([
          ...Array.from(encodeTelnetCommand(TelnetCommand.DONT, TelnetOption.SGA)),
          ...Array.from(encodeTelnetCommand(TelnetCommand.WONT, TelnetOption.ECHO)),
        ]),
      );
    });
    try {
      const session = await createTelnetTerminalSession({
        address: "127.0.0.1",
        port: server.port,
      });
      await delay(200);
      expect(server.clientSequences()).toHaveLength(5);
      session.kill();
      await session.killAndWait();
    } finally {
      await server.close();
    }
  });

  it("feeds server data to the emulator, writes input raw without local echo, and resends NAWS on resize", async () => {
    let acceptPeer: (socket: Socket) => void = () => {};
    const peerConnected = new Promise<Socket>((resolve) => {
      acceptPeer = resolve;
    });
    const server = await startFakeTelnetServer((socket) => acceptPeer(socket));
    try {
      const session = await createTelnetTerminalSession({
        address: "127.0.0.1",
        port: server.port,
        cols: 80,
        rows: 24,
      });
      const peer = await peerConnected;
      const outputs: string[] = [];
      const unsubscribe = session.subscribe((msg) => {
        if (msg.type === "output") {
          outputs.push(msg.data);
        }
      });

      peer.write(new TextEncoder().encode("hello from server\r\n"));
      await waitFor(() => outputs.join("").includes("hello from server"), "server output");

      session.send({ type: "input", data: "x" });
      await waitFor(() => server.receivedText().endsWith("x"), "input byte at server");
      expect(outputs.join("")).not.toContain("x");

      peer.write(new TextEncoder().encode("x"));
      await waitFor(() => outputs.join("").endsWith("x"), "echoed input");

      session.send({ type: "resize", rows: 40, cols: 120 });
      expect(session.getSize()).toEqual({ rows: 40, cols: 120 });
      expect(session.getState().rows).toBe(40);
      const secondNaws = encodeNaws(120, 40);
      await waitFor(
        () => containsBytes(server.received(), secondNaws),
        "re-sent NAWS after resize",
      );
      unsubscribe();
      session.kill();
      await session.killAndWait();
    } finally {
      await server.close();
    }
  });

  it("emits exit with last output lines when the socket closes", async () => {
    const server = await startFakeTelnetServer(writeTwoLinesThenDestroy);
    try {
      const session = await createTelnetTerminalSession({
        address: "127.0.0.1",
        port: server.port,
      });
      let exitInfo: {
        exitCode: number | null;
        signal: number | null;
        lastOutputLines: string[];
      } | null = null;
      session.onExit((info) => {
        exitInfo = info;
      });
      await waitFor(() => exitInfo !== null, "exit event");
      expect(exitInfo!.lastOutputLines).toContain("second");
      expect(exitInfo!.lastOutputLines).toContain("first");
      expect(exitInfo!.exitCode).toBeNull();
      expect(session.getExitInfo()).toEqual(exitInfo);
      await session.killAndWait();
    } finally {
      await server.close();
    }
  });

  it("rejects creation when the port refuses connections", async () => {
    const closed = await startFakeTelnetServer();
    const port = closed.port;
    await closed.close();
    await expect(
      createTelnetTerminalSession({ address: "127.0.0.1", port, connectTimeoutMs: 2_000 }),
    ).rejects.toBeInstanceOf(TelnetConnectionError);
  });
});

// The busybox telnetd container is external infrastructure; when the port is
// refused (CI without docker) these tests skip so the suite stays green.
describe.skipIf(!telnetdReachable)("TelnetTerminalSession against jad-sshd-telnet", () => {
  it("runs an interactive session: echo reaches the grid with the negotiated size", async () => {
    const session = await createTelnetTerminalSession({
      address: "127.0.0.1",
      port: TELNETD_PORT,
      cols: 80,
      rows: 24,
      workspaceId: "ws_test",
      name: "Telnet test",
    });
    try {
      const outputs: string[] = [];
      const unsubscribe = session.subscribe(
        (msg) => {
          if (msg.type === "output") {
            outputs.push(msg.data);
          }
        },
        { initialSnapshot: "ready" },
      );

      session.send({ type: "input", data: "echo hi\n" });
      await waitFor(() => outputs.join("").includes("hi"), "echo output from telnetd");

      // Server echoes the line once; the session must not have echoed it locally.
      const accumulated = outputs.join("");
      expect(countOccurrences(accumulated, "echo hi")).toBe(1);

      const state = session.getState();
      expect(state.rows).toBe(24);
      expect(state.cols).toBe(80);
      const gridLines = state.grid.map((row) => rowText(row));
      expect(gridLines.some((line) => line.includes("hi"))).toBe(true);

      session.send({ type: "resize", rows: 30, cols: 90 });
      await delay(200);
      expect(session.getSize()).toEqual({ rows: 30, cols: 90 });
      unsubscribe();
    } finally {
      await session.killAndWait();
    }
  });
});

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        continue outer;
      }
    }
    return true;
  }
  return false;
}

async function waitForSequences(
  server: FakeTelnetServer,
  count: number,
  timeoutMs = 8_000,
): Promise<TelnetSequence[]> {
  await waitFor(
    () => server.clientSequences().length >= count,
    `${count} client sequences`,
    timeoutMs,
  );
  return server.clientSequences();
}
