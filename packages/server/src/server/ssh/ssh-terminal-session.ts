import type { Terminal as TerminalType } from "@xterm/headless";
import xterm from "@xterm/headless";
import { randomBytes } from "node:crypto";
import type {
  TerminalActivity,
  TerminalActivityState,
} from "@jagentdesk/protocol/terminal-activity";
import { TerminalInputModeTracker } from "@jagentdesk/protocol/terminal-input-mode";
import { TerminalActivityTracker } from "../../terminal/activity/terminal-activity-tracker.js";
import {
  extractCursorState,
  extractGrid,
  extractGridWrapped,
  extractLastOutputLines,
  extractLastOutputLinesFromText,
  extractScrollback,
  extractScrollbackWrapped,
  resolveInitialTitleMode,
  toTerminalActivity,
  TERMINAL_EXIT_OUTPUT_CHAR_LIMIT,
  TERMINAL_EXIT_OUTPUT_LINE_LIMIT,
  TERMINAL_OSC_COLOR_QUERY_RESPONSES,
  TERMINAL_TITLE_DEBOUNCE_MS,
} from "../../terminal/terminal.js";
import type {
  ClientMessage,
  TerminalActivityTransition,
  TerminalCommandFinishedInfo,
  TerminalExitInfo,
  TerminalSession,
  TerminalStateSnapshot,
  TerminalStateSnapshotOptions,
  TerminalSubscribeOptions,
  ServerMessage,
} from "../../terminal/terminal.js";
import type { TerminalState } from "@jagentdesk/protocol/messages";

const { Terminal } = xterm;

// Remote (SSH / Telnet) terminal session (spec 25.4). Implements the same
// TerminalSession contract as createTerminal so the TerminalSessionController
// slot/binary-frame machinery drives it unchanged. The difference is the source:
// instead of a PTY child, a RemoteShell (ssh2 shell channel or Telnet socket) is
// attached by the SSH service — and re-attached after an auto-reconnect, so the
// headless emulator (screen + scrollback) survives connection drops (spec 25.3 step 6).
// Without an attached shell, input is dropped and system text (banner, connect
// errors, reconnect notices) writes straight into the emulator. The session only
// ends when the service calls `end()` or a client kills it.

/** What the session needs from the transport. */
export interface RemoteShell {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export interface SshTerminalSessionOptions {
  id: string;
  name: string;
  /** Display-only pseudo path (e.g. `ssh://host:22`); never a real fs path. */
  cwd: string;
  serverId: string;
  cols: number;
  rows: number;
  title?: string;
  scrollback?: number;
}

export interface SshTerminalExitSource {
  exitCode?: number | null;
  signal?: number | null;
}

export class SshTerminalSession implements TerminalSession {
  readonly id: string;
  readonly name: string;
  readonly cwd: string;
  readonly serverId: string;
  // SSH terminals belong to no local workspace (spec 25.4). The empty id never
  // matches a workspace, so workspace-scoped listing/kill paths never see them.
  readonly workspaceId = "";

  private readonly terminal: TerminalType;
  private readonly listeners = new Set<(msg: ServerMessage) => void>();
  private readonly exitListeners = new Set<(info: TerminalExitInfo) => void>();
  private readonly titleChangeListeners = new Set<(title?: string) => void>();
  private readonly activityChangeListeners = new Set<
    (transition: TerminalActivityTransition) => void
  >();
  private readonly inputModeTracker = new TerminalInputModeTracker();
  private readonly activityTracker = new TerminalActivityTracker();

  private shell: RemoteShell | null = null;
  private readonly outputTaps = new Set<(data: string) => void>();
  private readonly inputTaps = new Set<(data: string) => void>();
  private pendingInput = "";
  private inputFlushImmediate: ReturnType<typeof setImmediate> | null = null;
  private stateRevision = 0;
  private killed = false;
  private disposed = false;
  private exitEmitted = false;
  private ended = false;
  private exitInfo: TerminalExitInfo | null = null;
  private readonly recentOutputChunks: string[] = [];
  private recentOutputLength = 0;
  private title: string | undefined;
  private pendingTitle: string | undefined;
  private titleDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private titleChangeSubscription: { dispose(): void } | null = null;
  /** Set by the SSH service: a client kill must tear the connection down too. */
  onKill: (() => void) | null = null;

  constructor(options: SshTerminalSessionOptions) {
    this.id = options.id;
    this.name = options.name;
    this.cwd = options.cwd;
    this.serverId = options.serverId;
    this.terminal = new Terminal({
      rows: options.rows,
      cols: options.cols,
      scrollback: options.scrollback ?? 5000,
      allowProposedApi: true,
    });
    this.registerQueryHandlers();
    if (resolveInitialTitleMode(options.title) === "auto") {
      this.titleChangeSubscription = this.terminal.onTitleChange((nextTitle) => {
        if (this.disposed || this.killed) return;
        this.pendingTitle = nextTitle.trim().length > 0 ? nextTitle : undefined;
        if (this.titleDebounceTimer) clearTimeout(this.titleDebounceTimer);
        this.titleDebounceTimer = setTimeout(() => {
          this.titleDebounceTimer = null;
          this.emitTitleChange(this.pendingTitle);
          this.pendingTitle = undefined;
        }, TERMINAL_TITLE_DEBOUNCE_MS);
      });
    }
    this.activityTracker.onChange((snapshot, previousSnapshot) => {
      if (this.disposed || this.killed) return;
      const transition: TerminalActivityTransition = {
        activity: toTerminalActivity(snapshot),
        previous: toTerminalActivity(previousSnapshot),
      };
      for (const listener of Array.from(this.activityChangeListeners)) {
        try {
          listener(transition);
        } catch {
          // no-op
        }
      }
    });
    const initialTitle = options.title?.trim() || undefined;
    if (initialTitle) this.emitTitleChange(initialTitle);
  }

  // ── service surface ───────────────────────────────────────────────────

  /** Attach a live shell (first connect or after a reconnect). */
  attachShell(shell: RemoteShell): void {
    if (this.killed || this.ended) {
      shell.close();
      return;
    }
    this.shell = shell;
    // The remote side starts at its own default size; sync it to the emulator.
    shell.resize(this.terminal.cols, this.terminal.rows);
  }

  /** The shell went away (drop or reconnect); the screen stays. */
  detachShell(): void {
    this.shell = null;
  }

  hasShell(): boolean {
    return this.shell !== null;
  }

  /** Bytes from the remote shell. */
  pushRemoteOutput(data: string): void {
    this.pushOutput(data);
  }

  /** Write daemon-side text (banner, connect failure, reconnect notice) into the emulator. */
  writeSystem(text: string): void {
    this.pushOutput(text);
  }

  /** Type into the remote shell as if the user had (snippets, password key). */
  typeInput(data: string): void {
    this.send({ type: "input", data });
  }

  /** Observe remote output (session logs, S6). Returns an unsubscribe. */
  tapOutput(listener: (data: string) => void): () => void {
    this.outputTaps.add(listener);
    return () => this.outputTaps.delete(listener);
  }

  /** Observe what is sent to the remote shell (command history, S5). */
  tapInput(listener: (data: string) => void): () => void {
    this.inputTaps.add(listener);
    return () => this.inputTaps.delete(listener);
  }

  isEnded(): boolean {
    return this.ended || this.killed;
  }

  /** The session is over (remote shell exited, or the service gave up). */
  end(source?: SshTerminalExitSource): void {
    if (this.ended || this.killed) return;
    this.ended = true;
    this.flushPendingInput();
    this.shell = null;
    this.emitExit(this.buildExitInfo(source));
    this.disposeResources();
  }

  // ── TerminalSession ────────────────────────────────────────────────────

  send(msg: ClientMessage): void {
    if (this.killed) return;
    switch (msg.type) {
      case "input":
        this.pendingInput += msg.data;
        this.scheduleInputFlush();
        break;
      case "resize":
        this.flushPendingInput();
        if (msg.cols > 0 && msg.rows > 0) {
          this.terminal.resize(msg.cols, msg.rows);
          this.shell?.resize(msg.cols, msg.rows);
          this.stateRevision += 1;
        }
        break;
      case "mouse":
        // Ignored, matching the PTY terminal.
        break;
    }
  }

  subscribe(
    listener: (msg: ServerMessage) => void,
    subscribeOptions?: TerminalSubscribeOptions,
  ): () => void {
    let active = true;
    let snapshotDelivered = false;
    const queuedMessages: ServerMessage[] = [];
    const initialSnapshot = subscribeOptions?.initialSnapshot ?? "state";
    const subscriptionListener = (msg: ServerMessage): void => {
      if (!active) return;
      if (!snapshotDelivered) {
        queuedMessages.push(msg);
        return;
      }
      listener(msg);
    };
    this.listeners.add(subscriptionListener);

    this.terminal.write("", () => {
      if (!this.disposed && active && this.listeners.has(subscriptionListener)) {
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
      }
    });

    return () => {
      active = false;
      queuedMessages.length = 0;
      this.listeners.delete(subscriptionListener);
    };
  }

  onExit(listener: (info: TerminalExitInfo) => void): () => void {
    if (this.killed || this.ended) {
      queueMicrotask(() => {
        try {
          listener(this.exitInfo ?? this.buildExitInfo());
        } catch {
          // no-op
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
    // No shell integration on a remote shell; nothing to report.
    return () => {};
  }

  onTitleChange(listener: (title?: string) => void): () => void {
    this.titleChangeListeners.add(listener);
    if (this.title !== undefined) {
      queueMicrotask(() => {
        if (this.disposed || !this.titleChangeListeners.has(listener)) return;
        try {
          listener(this.title);
        } catch {
          // no-op
        }
      });
    }
    return () => {
      this.titleChangeListeners.delete(listener);
    };
  }

  onActivityChange(listener: (transition: TerminalActivityTransition) => void): () => void {
    this.activityChangeListeners.add(listener);
    return () => {
      this.activityChangeListeners.delete(listener);
    };
  }

  getSize(): { rows: number; cols: number } {
    return { rows: this.terminal.rows, cols: this.terminal.cols };
  }

  getState(snapshotOptions?: TerminalStateSnapshotOptions): TerminalState {
    return {
      rows: this.terminal.rows,
      cols: this.terminal.cols,
      grid: extractGrid(this.terminal),
      scrollback: extractScrollback(this.terminal, {
        scrollbackLines: snapshotOptions?.scrollbackLines,
      }),
      cursor: extractCursorState(this.terminal),
      ...(this.title ? { title: this.title } : {}),
      ...(snapshotOptions?.includeWrapFlags
        ? {
            gridWrapped: extractGridWrapped(this.terminal),
            scrollbackWrapped: extractScrollbackWrapped(this.terminal, {
              scrollbackLines: snapshotOptions?.scrollbackLines,
            }),
          }
        : {}),
    };
  }

  getStateSnapshot(snapshotOptions?: TerminalStateSnapshotOptions): TerminalStateSnapshot {
    return { state: this.getState(snapshotOptions), revision: this.stateRevision };
  }

  getReplayPreamble(): string {
    return this.inputModeTracker.getPreamble();
  }

  getTitle(): string | undefined {
    return this.title;
  }

  getActivity(): TerminalActivity | null {
    return toTerminalActivity(this.activityTracker.getSnapshot());
  }

  setActivity(state: TerminalActivityState): void {
    this.activityTracker.set(state);
  }

  clearActivityAttention(): boolean {
    return this.activityTracker.clearAttention();
  }

  setTitle(nextTitle: string): void {
    const manualTitle = nextTitle.trim();
    if (!manualTitle) return;
    this.titleChangeSubscription?.dispose();
    this.titleChangeSubscription = null;
    this.pendingTitle = undefined;
    if (this.titleDebounceTimer) {
      clearTimeout(this.titleDebounceTimer);
      this.titleDebounceTimer = null;
    }
    this.emitTitleChange(manualTitle);
  }

  getExitInfo(): TerminalExitInfo | null {
    return this.exitInfo;
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    const shell = this.shell;
    this.shell = null;
    shell?.close();
    this.emitExit(this.buildExitInfo());
    this.onKill?.();
    this.disposeResources();
  }

  async killAndWait(_options?: {
    gracefulTimeoutMs?: number;
    forceTimeoutMs?: number;
  }): Promise<void> {
    this.kill();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private registerQueryHandlers(): void {
    const writeResponse = (data: string): void => {
      this.shell?.write(data);
    };
    this.terminal.parser.registerCsiHandler({ final: "c" }, (params) => {
      if (params.length === 0 || (params.length === 1 && params[0] === 0)) {
        writeResponse("\x1b[?62;4;22c");
        return true;
      }
      return false;
    });
    this.terminal.parser.registerCsiHandler({ final: "n" }, (params) => {
      if (params.length !== 1) return false;
      if (params[0] === 5) {
        writeResponse("\x1b[0n");
        return true;
      }
      if (params[0] === 6) {
        const buffer = this.terminal.buffer.active;
        writeResponse(`\x1b[${buffer.cursorY + 1};${buffer.cursorX + 1}R`);
        return true;
      }
      return false;
    });
    this.terminal.parser.registerCsiHandler({ prefix: "?", final: "n" }, (params) => {
      if (params.length !== 1 || params[0] !== 6) return false;
      const buffer = this.terminal.buffer.active;
      writeResponse(`\x1b[?${buffer.cursorY + 1};${buffer.cursorX + 1}R`);
      return true;
    });
    for (const [code, response] of TERMINAL_OSC_COLOR_QUERY_RESPONSES) {
      this.terminal.parser.registerOscHandler(code, (data) => {
        if (data.trim() !== "?") return false;
        writeResponse(`\x1b]${code};${response}\x1b\\`);
        return true;
      });
    }
  }

  private pushOutput(data: string): void {
    if (this.killed || this.disposed) return;
    const inputModeUpdate = this.inputModeTracker.feed(data);
    for (const response of inputModeUpdate.responses) {
      this.shell?.write(response);
    }
    for (const tap of Array.from(this.outputTaps)) {
      try {
        tap(data);
      } catch {
        // no-op
      }
    }
    this.recentOutputChunks.push(data);
    this.recentOutputLength += data.length;
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
    this.terminal.write(data, () => {
      if (this.disposed || this.killed) return;
      this.stateRevision += 1;
      for (const listener of this.listeners) {
        listener({ type: "output", data, revision: this.stateRevision });
      }
    });
  }

  private emitTitleChange(nextTitle: string | undefined): void {
    if (this.title === nextTitle) return;
    this.title = nextTitle;
    for (const listener of Array.from(this.titleChangeListeners)) {
      try {
        listener(this.title);
      } catch {
        // no-op
      }
    }
    for (const listener of Array.from(this.listeners)) {
      try {
        listener({ type: "titleChange", title: this.title });
      } catch {
        // no-op
      }
    }
  }

  private buildExitInfo(input?: SshTerminalExitSource): TerminalExitInfo {
    const lastOutputLines = extractLastOutputLines(this.terminal, TERMINAL_EXIT_OUTPUT_LINE_LIMIT);
    return {
      exitCode: input?.exitCode ?? null,
      signal: input?.signal && input.signal > 0 ? input.signal : null,
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
    if (this.exitEmitted) return;
    this.exitEmitted = true;
    this.exitInfo = info;
    for (const listener of Array.from(this.exitListeners)) {
      try {
        listener(info);
      } catch {
        // no-op
      }
    }
    this.exitListeners.clear();
  }

  private flushPendingInput(): void {
    if (this.inputFlushImmediate) {
      clearImmediate(this.inputFlushImmediate);
      this.inputFlushImmediate = null;
    }
    const data = this.pendingInput;
    this.pendingInput = "";
    if (!data || this.killed || this.disposed || !this.shell) return;
    for (const tap of Array.from(this.inputTaps)) {
      try {
        tap(data);
      } catch {
        // no-op
      }
    }
    this.shell.write(data);
  }

  private scheduleInputFlush(): void {
    if (this.inputFlushImmediate) return;
    this.inputFlushImmediate = setImmediate(() => {
      this.inputFlushImmediate = null;
      this.flushPendingInput();
    });
  }

  private disposeResources(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.outputTaps.clear();
    this.inputTaps.clear();
    this.activityTracker.clear();
    this.pendingInput = "";
    this.recentOutputChunks.length = 0;
    this.recentOutputLength = 0;
    this.inputModeTracker.reset();
    if (this.inputFlushImmediate) {
      clearImmediate(this.inputFlushImmediate);
      this.inputFlushImmediate = null;
    }
    if (this.titleDebounceTimer) {
      clearTimeout(this.titleDebounceTimer);
      this.titleDebounceTimer = null;
    }
    this.titleChangeSubscription?.dispose();
    this.titleChangeSubscription = null;
    this.activityTracker.dispose();
    this.terminal.dispose();
    this.listeners.clear();
    this.exitListeners.clear();
    this.titleChangeListeners.clear();
    this.activityChangeListeners.clear();
  }
}

export function createSshTerminalId(): string {
  return `ssh_${randomBytes(8).toString("hex")}`;
}
