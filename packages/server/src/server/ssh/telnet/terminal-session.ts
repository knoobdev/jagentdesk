import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import xterm, { type Terminal as TerminalType } from "@xterm/headless";
import type { TerminalCell, TerminalState } from "@jagentdesk/protocol/messages";
import type {
  TerminalActivity,
  TerminalActivityState,
} from "@jagentdesk/protocol/terminal-activity";
import type {
  ClientMessage,
  ServerMessage,
  TerminalActivityTransition,
  TerminalCommandFinishedInfo,
  TerminalExitInfo,
  TerminalSession,
  TerminalStateSnapshot,
  TerminalStateSnapshotOptions,
  TerminalSubscribeOptions,
} from "../../../terminal/terminal.js";
import {
  TelnetCommand,
  TelnetOption,
  TTYPE_SEND,
  createTelnetStreamParser,
  encodeNaws,
  encodeTelnetCommand,
  encodeTelnetData,
  encodeTtypeIs,
  type TelnetCommandCode,
  type TelnetSequence,
  type TelnetStreamParser,
} from "./iac.js";

const { Terminal } = xterm;

export const DEFAULT_TELNET_PORT = 23;
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const TELNET_CONNECT_TIMEOUT_MS = 10_000;
const TELNET_TERM_TYPE = "xterm-256color";
// createTelnetTerminalSession waits for the initial negotiation exchange to go
// quiet; a server that never negotiates must not block creation for long.
const NEGOTIATION_QUIET_MS = 150;
const NEGOTIATION_MAX_WAIT_MS = 1_500;
const NEGOTIATION_POLL_MS = 25;
const TERMINAL_EXIT_OUTPUT_LINE_LIMIT = 12;
const TERMINAL_EXIT_OUTPUT_CHAR_LIMIT = 16_000;
const ACCEPTED_DO_OPTIONS = new Set<number>([
  TelnetOption.ECHO,
  TelnetOption.SGA,
  TelnetOption.NAWS,
  TelnetOption.TTYPE,
]);

export class TelnetConnectionError extends Error {
  constructor(
    public readonly address: string,
    public readonly port: number,
    reason: string,
  ) {
    super(`Telnet connection to ${address}:${port} failed: ${reason}`);
    this.name = "TelnetConnectionError";
  }
}

export interface CreateTelnetTerminalSessionOptions {
  address: string;
  port?: number;
  cols?: number;
  rows?: number;
  id?: string;
  workspaceId?: string;
  name?: string;
  connectTimeoutMs?: number;
}

interface TelnetTerminalSessionConfig {
  socket: Socket;
  address: string;
  port: number;
  cols: number;
  rows: number;
  id: string;
  workspaceId: string;
  name: string;
}

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const ANSI_SEQUENCE_PATTERN = new RegExp(
  `${ESC}(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~]|\\].*?(?:${BEL}|${ESC}\\\\))`,
  "g",
);

function extractCell(terminal: TerminalType, row: number, col: number): TerminalCell {
  const line = terminal.buffer.active.getLine(row);
  const cell = line?.getCell(col);
  if (!cell) {
    return { char: " ", fg: undefined, bg: undefined };
  }
  // Color mode is packed into the upper byte (0 = default); see terminal.ts.
  const fgMode = cell.getFgColorMode() >> 24;
  const bgMode = cell.getBgColorMode() >> 24;
  return {
    char: cell.getChars() || " ",
    fg: fgMode !== 0 ? cell.getFgColor() : undefined,
    bg: bgMode !== 0 ? cell.getBgColor() : undefined,
    fgMode: fgMode !== 0 ? fgMode : undefined,
    bgMode: bgMode !== 0 ? bgMode : undefined,
    bold: cell.isBold() !== 0,
    italic: cell.isItalic() !== 0,
    underline: cell.isUnderline() !== 0,
    dim: cell.isDim() !== 0,
    inverse: cell.isInverse() !== 0,
    strikethrough: cell.isStrikethrough() !== 0,
  };
}

function extractGrid(terminal: TerminalType): TerminalCell[][] {
  const baseY = terminal.buffer.active.baseY;
  const grid: TerminalCell[][] = [];
  for (let row = 0; row < terminal.rows; row++) {
    const rowCells: TerminalCell[] = [];
    for (let col = 0; col < terminal.cols; col++) {
      rowCells.push(extractCell(terminal, baseY + row, col));
    }
    grid.push(rowCells);
  }
  return grid;
}

function extractScrollback(terminal: TerminalType, scrollbackLines?: number): TerminalCell[][] {
  const buffer = terminal.buffer.active;
  const startRow =
    typeof scrollbackLines === "number" ? Math.max(0, buffer.baseY - scrollbackLines) : 0;
  const scrollback: TerminalCell[][] = [];
  for (let row = startRow; row < buffer.baseY; row++) {
    const rowCells: TerminalCell[] = [];
    for (let col = 0; col < terminal.cols; col++) {
      rowCells.push(extractCell(terminal, row, col));
    }
    scrollback.push(rowCells);
  }
  return scrollback;
}

// xterm marks a line isWrapped when it continues the PREVIOUS line; the snapshot
// flag means "this row continues onto the next row", so it reads line y+1.
function lineContinuesToNext(terminal: TerminalType, absoluteRow: number): boolean {
  return terminal.buffer.active.getLine(absoluteRow + 1)?.isWrapped === true;
}

function extractGridWrapped(terminal: TerminalType): boolean[] {
  const baseY = terminal.buffer.active.baseY;
  const wrapped: boolean[] = [];
  for (let row = 0; row < terminal.rows; row++) {
    wrapped.push(lineContinuesToNext(terminal, baseY + row));
  }
  return wrapped;
}

function extractScrollbackWrapped(terminal: TerminalType, scrollbackLines?: number): boolean[] {
  const total = terminal.buffer.active.baseY;
  const startRow = typeof scrollbackLines === "number" ? Math.max(0, total - scrollbackLines) : 0;
  const wrapped: boolean[] = [];
  for (let row = startRow; row < total; row++) {
    wrapped.push(lineContinuesToNext(terminal, row));
  }
  return wrapped;
}

function extractLastOutputLines(terminal: TerminalType, limit: number): string[] {
  const buffer = terminal.buffer.active;
  const mergedLines: string[] = [];
  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row);
    if (!line) {
      continue;
    }
    const text = line.translateToString(true);
    if (line.isWrapped && mergedLines.length > 0) {
      mergedLines[mergedLines.length - 1] += text;
      continue;
    }
    mergedLines.push(text);
  }
  while (mergedLines.length > 0 && mergedLines[0]?.trim().length === 0) {
    mergedLines.shift();
  }
  while (mergedLines.length > 0 && mergedLines[mergedLines.length - 1]?.trim().length === 0) {
    mergedLines.pop();
  }
  return mergedLines.slice(-limit);
}

function extractLastOutputLinesFromText(text: string, limit: number): string[] {
  const normalized = text
    .replace(ANSI_SEQUENCE_PATTERN, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  const lines = normalized.split("\n").map((line) => line.trimEnd());
  while (lines[0]?.trim().length === 0) {
    lines.shift();
  }
  while (lines[lines.length - 1]?.trim().length === 0) {
    lines.pop();
  }
  return lines.slice(-limit);
}

function negotiationReply(command: TelnetCommandCode, option: number): Uint8Array | undefined {
  if (command === TelnetCommand.WILL) {
    if (option === TelnetOption.ECHO || option === TelnetOption.SGA) {
      return encodeTelnetCommand(TelnetCommand.DO, option);
    }
    return encodeTelnetCommand(TelnetCommand.WONT, option);
  }
  if (command === TelnetCommand.DO) {
    if (ACCEPTED_DO_OPTIONS.has(option)) {
      return encodeTelnetCommand(TelnetCommand.WILL, option);
    }
    return encodeTelnetCommand(TelnetCommand.WONT, option);
  }
  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openTelnetSocket(address: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: address, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new TelnetConnectionError(address, port, `connect timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const onError = (error: Error): void => {
      clearTimeout(timer);
      socket.destroy();
      reject(new TelnetConnectionError(address, port, error.message));
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.removeListener("error", onError);
      resolve(socket);
    });
  });
}

/**
 * Plain (unencrypted) TCP Telnet terminal session. Grid/scrollback semantics
 * mirror terminal.ts so the terminal RPC layer can treat both alike; ECHO from
 * the server is relayed, and input is never echoed locally.
 */
export class TelnetTerminalSession implements TerminalSession {
  readonly id: string;
  readonly name: string;
  readonly cwd: string;
  readonly workspaceId: string;

  private readonly socket: Socket;
  private readonly terminal: TerminalType;
  private readonly parser: TelnetStreamParser = createTelnetStreamParser();
  private readonly listeners = new Set<(msg: ServerMessage) => void>();
  private readonly exitListeners = new Set<(info: TerminalExitInfo) => void>();
  private readonly titleChangeListeners = new Set<(title?: string) => void>();
  private readonly socketCloseWaiters = new Set<() => void>();
  private killed = false;
  private disposed = false;
  private exitEmitted = false;
  private socketClosed = false;
  private exitInfo: TerminalExitInfo | null = null;
  private recentOutputChunks: string[] = [];
  private recentOutputLength = 0;
  private stateRevision = 0;
  private title: string | undefined;
  private lastNegotiationAt = Date.now();

  constructor(config: TelnetTerminalSessionConfig) {
    this.id = config.id;
    this.name = config.name;
    this.cwd = `${config.address}:${config.port}`;
    this.workspaceId = config.workspaceId;
    this.socket = config.socket;
    this.terminal = new Terminal({
      rows: config.rows,
      cols: config.cols,
      scrollback: 1000,
      allowProposedApi: true,
    });

    this.registerEmulatorQueryHandlers();

    this.socket.on("data", (chunk: Buffer) => this.handleSocketData(chunk));
    this.socket.on("close", () => this.handleClose());
    this.socket.on("error", () => this.handleClose());

    this.sendInitialNegotiation();
  }

  // terminal.ts answers DA1/DSR queries from the emulator parser; the remote
  // side expects the same responses, so mirror it and write them to the socket.
  private registerEmulatorQueryHandlers(): void {
    this.terminal.parser.registerCsiHandler({ final: "c" }, (params) => {
      if (params.length === 0 || (params.length === 1 && params[0] === 0)) {
        this.socket.write("\x1b[?62;4;22c");
        return true;
      }
      return false;
    });
    this.terminal.parser.registerCsiHandler({ final: "n" }, (params) => {
      if (params.length !== 1) {
        return false;
      }
      if (params[0] === 5) {
        this.socket.write("\x1b[0n");
        return true;
      }
      if (params[0] === 6) {
        const buffer = this.terminal.buffer.active;
        this.socket.write(`\x1b[${buffer.cursorY + 1};${buffer.cursorX + 1}R`);
        return true;
      }
      return false;
    });
    this.terminal.parser.registerCsiHandler({ prefix: "?", final: "n" }, (params) => {
      if (params.length !== 1 || params[0] !== 6) {
        return false;
      }
      const buffer = this.terminal.buffer.active;
      this.socket.write(`\x1b[?${buffer.cursorY + 1};${buffer.cursorX + 1}R`);
      return true;
    });
  }

  private sendInitialNegotiation(): void {
    this.socket.write(encodeTelnetCommand(TelnetCommand.WILL, TelnetOption.SGA));
    this.socket.write(encodeTelnetCommand(TelnetCommand.WILL, TelnetOption.ECHO));
    this.socket.write(encodeTelnetCommand(TelnetCommand.WILL, TelnetOption.NAWS));
    this.socket.write(encodeTelnetCommand(TelnetCommand.WILL, TelnetOption.TTYPE));
    this.sendNaws();
  }

  private sendNaws(): void {
    this.writeToSocket(encodeNaws(this.terminal.cols, this.terminal.rows));
  }

  private writeToSocket(bytes: Uint8Array): void {
    if (this.killed || this.socketClosed) {
      return;
    }
    this.socket.write(bytes);
  }

  /**
   * Resolves once the server's opening negotiation round is finished (no new
   * IAC sequences for NEGOTIATION_QUIET_MS) or the wait cap is hit, so servers
   * that never negotiate don't stall session creation.
   */
  async waitForInitialNegotiation(): Promise<void> {
    const start = Date.now();
    for (;;) {
      if (this.socketClosed) {
        return;
      }
      const now = Date.now();
      if (
        now - this.lastNegotiationAt >= NEGOTIATION_QUIET_MS ||
        now - start >= NEGOTIATION_MAX_WAIT_MS
      ) {
        return;
      }
      await delay(NEGOTIATION_POLL_MS);
    }
  }

  private handleSocketData(chunk: Buffer): void {
    const parsed = this.parser.push(chunk);
    for (const sequence of parsed.sequences) {
      this.lastNegotiationAt = Date.now();
      this.handleSequence(sequence);
    }
    if (parsed.data.length > 0) {
      this.writeOutputToHeadless(parsed.data);
    }
  }

  private handleSequence(sequence: TelnetSequence): void {
    if (sequence.kind === "command") {
      const reply = negotiationReply(sequence.command, sequence.option);
      if (reply) {
        this.writeToSocket(reply);
      }
      return;
    }
    if (sequence.option === TelnetOption.TTYPE && sequence.data[0] === TTYPE_SEND) {
      this.writeToSocket(encodeTtypeIs(TELNET_TERM_TYPE));
    }
  }

  private rememberRecentOutput(text: string): void {
    this.recentOutputChunks.push(text);
    this.recentOutputLength += text.length;
    while (
      this.recentOutputChunks.length > 1 &&
      this.recentOutputLength - this.recentOutputChunks[0].length >= TERMINAL_EXIT_OUTPUT_CHAR_LIMIT
    ) {
      this.recentOutputLength -= this.recentOutputChunks[0].length;
      this.recentOutputChunks.shift();
    }
    if (
      this.recentOutputChunks.length === 1 &&
      this.recentOutputLength > TERMINAL_EXIT_OUTPUT_CHAR_LIMIT
    ) {
      const tail = this.recentOutputChunks[0].slice(-TERMINAL_EXIT_OUTPUT_CHAR_LIMIT);
      this.recentOutputChunks[0] = tail;
      this.recentOutputLength = tail.length;
    }
  }

  private writeOutputToHeadless(data: Uint8Array): void {
    const text = Buffer.from(data).toString("utf8");
    this.rememberRecentOutput(text);
    this.terminal.write(data, () => {
      if (this.disposed || this.killed) {
        return;
      }
      this.stateRevision += 1;
      for (const listener of this.listeners) {
        listener({ type: "output", data: text, revision: this.stateRevision });
      }
    });
  }

  private handleClose(): void {
    if (this.socketClosed) {
      return;
    }
    this.socketClosed = true;
    this.killed = true;
    for (const waiter of Array.from(this.socketCloseWaiters)) {
      waiter();
    }
    this.socketCloseWaiters.clear();
    this.emitExit(this.buildExitInfo());
    this.disposeResources();
  }

  private buildExitInfo(): TerminalExitInfo {
    const lastOutputLines = extractLastOutputLines(this.terminal, TERMINAL_EXIT_OUTPUT_LINE_LIMIT);
    return {
      exitCode: null,
      signal: null,
      lastOutputLines:
        lastOutputLines.length > 0
          ? lastOutputLines
          : extractLastOutputLinesFromText(
              this.recentOutputChunks.join("").slice(-TERMINAL_EXIT_OUTPUT_CHAR_LIMIT),
              TERMINAL_EXIT_OUTPUT_LINE_LIMIT,
            ),
    };
  }

  private emitExit(info: TerminalExitInfo): void {
    if (this.exitEmitted) {
      return;
    }
    this.exitEmitted = true;
    this.exitInfo = info;
    for (const listener of Array.from(this.exitListeners)) {
      try {
        listener(info);
      } catch {
        // one bad listener must not stop the others
      }
    }
    this.exitListeners.clear();
  }

  private disposeResources(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.recentOutputChunks.length = 0;
    this.recentOutputLength = 0;
    this.terminal.dispose();
    this.listeners.clear();
    this.exitListeners.clear();
    this.titleChangeListeners.clear();
  }

  private destroySocket(): void {
    if (!this.socketClosed) {
      this.socket.destroy();
    }
  }

  private waitForSocketClose(timeoutMs: number): Promise<void> {
    if (this.socketClosed) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let pendingResolve: (() => void) | null = resolve;
      const settle = (): void => {
        if (!pendingResolve) {
          return;
        }
        const fn = pendingResolve;
        pendingResolve = null;
        clearTimeout(timer);
        this.socketCloseWaiters.delete(waiter);
        fn();
      };
      const waiter = (): void => {
        settle();
      };
      const timer = setTimeout(waiter, timeoutMs);
      this.socketCloseWaiters.add(waiter);
    });
  }

  send(msg: ClientMessage): void {
    if (this.killed) {
      return;
    }
    switch (msg.type) {
      case "input":
        // The server echoes; never echo locally.
        this.writeToSocket(encodeTelnetData(msg.data));
        break;
      case "resize":
        this.terminal.resize(msg.cols, msg.rows);
        this.stateRevision += 1;
        this.sendNaws();
        break;
      case "mouse":
        break;
    }
  }

  subscribe(
    listener: (msg: ServerMessage) => void,
    options?: TerminalSubscribeOptions,
  ): () => void {
    let active = true;
    let snapshotDelivered = false;
    const queuedMessages: ServerMessage[] = [];
    const initialSnapshot = options?.initialSnapshot ?? "state";
    const subscriptionListener = (msg: ServerMessage): void => {
      if (!active) {
        return;
      }
      if (!snapshotDelivered) {
        queuedMessages.push(msg);
        return;
      }
      listener(msg);
    };

    this.listeners.add(subscriptionListener);

    this.terminal.write("", () => {
      if (this.disposed || !active || !this.listeners.has(subscriptionListener)) {
        return;
      }
      snapshotDelivered = true;
      if (initialSnapshot === "ready") {
        listener({
          type: "snapshotReady",
          revision: this.stateRevision,
          replayPreamble: this.getReplayPreamble(),
        });
      } else {
        listener({ type: "snapshot", ...this.getStateSnapshot() });
      }
      for (const message of queuedMessages.splice(0)) {
        listener(message);
      }
    });

    return () => {
      active = false;
      queuedMessages.length = 0;
      this.listeners.delete(subscriptionListener);
    };
  }

  onExit(listener: (info: TerminalExitInfo) => void): () => void {
    if (this.killed) {
      queueMicrotask(() => {
        try {
          listener(this.exitInfo ?? this.buildExitInfo());
        } catch {
          // listener isolation
        }
      });
      return () => {};
    }
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  onCommandFinished(_listener: (info: TerminalCommandFinishedInfo) => void): () => void {
    return () => {};
  }

  onTitleChange(listener: (title?: string) => void): () => void {
    this.titleChangeListeners.add(listener);
    if (this.title !== undefined) {
      queueMicrotask(() => {
        if (this.disposed || !this.titleChangeListeners.has(listener)) {
          return;
        }
        try {
          listener(this.title);
        } catch {
          // listener isolation
        }
      });
    }
    return () => {
      this.titleChangeListeners.delete(listener);
    };
  }

  onActivityChange(_listener: (transition: TerminalActivityTransition) => void): () => void {
    return () => {};
  }

  getSize(): { rows: number; cols: number } {
    return { rows: this.terminal.rows, cols: this.terminal.cols };
  }

  getState(): TerminalState {
    return this.buildState();
  }

  getStateSnapshot(options?: TerminalStateSnapshotOptions): TerminalStateSnapshot {
    return { state: this.buildState(options), revision: this.stateRevision };
  }

  private buildState(options?: TerminalStateSnapshotOptions): TerminalState {
    const buffer = this.terminal.buffer.active;
    return {
      rows: this.terminal.rows,
      cols: this.terminal.cols,
      grid: extractGrid(this.terminal),
      scrollback: extractScrollback(this.terminal, options?.scrollbackLines),
      cursor: { row: buffer.cursorY, col: buffer.cursorX },
      ...(this.title ? { title: this.title } : {}),
      ...(options?.includeWrapFlags
        ? {
            gridWrapped: extractGridWrapped(this.terminal),
            scrollbackWrapped: extractScrollbackWrapped(this.terminal, options?.scrollbackLines),
          }
        : {}),
    };
  }

  getReplayPreamble(): string {
    return "";
  }

  getTitle(): string | undefined {
    return this.title;
  }

  setTitle(title: string): void {
    const manualTitle = title.trim();
    if (!manualTitle || manualTitle === this.title) {
      return;
    }
    this.title = manualTitle;
    for (const listener of Array.from(this.titleChangeListeners)) {
      try {
        listener(this.title);
      } catch {
        // listener isolation
      }
    }
    for (const listener of this.listeners) {
      listener({ type: "titleChange", title: this.title });
    }
  }

  getActivity(): TerminalActivity | null {
    return null;
  }

  setActivity(_state: TerminalActivityState): void {}

  clearActivityAttention(): boolean {
    return false;
  }

  getExitInfo(): TerminalExitInfo | null {
    return this.exitInfo;
  }

  kill(): void {
    if (this.killed) {
      return;
    }
    this.killed = true;
    this.destroySocket();
    this.emitExit(this.buildExitInfo());
    void this.waitForSocketClose(1_000).finally(() => this.disposeResources());
  }

  async killAndWait(options?: {
    gracefulTimeoutMs?: number;
    forceTimeoutMs?: number;
  }): Promise<void> {
    const timeoutMs = options?.gracefulTimeoutMs ?? options?.forceTimeoutMs ?? 2_000;
    this.destroySocket();
    await this.waitForSocketClose(timeoutMs);
    this.kill();
  }
}

export async function createTelnetTerminalSession(
  options: CreateTelnetTerminalSessionOptions,
): Promise<TelnetTerminalSession> {
  const address = options.address;
  const port = options.port ?? DEFAULT_TELNET_PORT;
  const socket = await openTelnetSocket(
    address,
    port,
    options.connectTimeoutMs ?? TELNET_CONNECT_TIMEOUT_MS,
  );
  const session = new TelnetTerminalSession({
    socket,
    address,
    port,
    cols: options.cols ?? DEFAULT_COLS,
    rows: options.rows ?? DEFAULT_ROWS,
    id: options.id ?? randomUUID(),
    workspaceId: options.workspaceId ?? "",
    name: options.name ?? "Telnet",
  });
  await session.waitForInitialNegotiation();
  return session;
}
