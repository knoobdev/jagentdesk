import type { Rectangle } from "electron";
import { ipcMain } from "electron";
import { BrowserAutomationExecuteRequestSchema } from "@jagentdesk/protocol/browser-automation/rpc-schemas";
import type { BrowserAutomationConsoleLogEntry } from "@jagentdesk/protocol/browser-automation/rpc-schemas";
import type { TabContents, BrowserRegistry, TabImage } from "./service.js";
import type { IsolatedKeyboardInputEvent } from "./trusted-input.js";
import { CdpSessionQueue } from "./cdp-session-queue.js";
import {
  answerDialog,
  drainDialogEvents,
  getPendingDialog,
  waitForDialog,
} from "./guest-dialogs.js";
import { executeAutomationCommand } from "./service.js";
import { BrowserSnapshotEngine } from "./snapshot-engine.js";
import {
  listRegisteredJAgentDeskBrowserIds,
  listRegisteredJAgentDeskBrowserIdsForWorkspace,
  getJAgentDeskBrowserWebContentsForHostWindow,
  getWorkspaceActiveJAgentDeskBrowserIdForHostWindow,
  getJAgentDeskBrowserWorkspaceId,
} from "../browser-webviews/index.js";

const MAX_CONSOLE_MESSAGES_PER_TAB = 200;
const consoleMessagesByContentsId = new Map<number, BrowserAutomationConsoleLogEntry[]>();
const cdpQueuesByContentsId = new Map<number, CdpSessionQueue>();
const observedContentsIds = new Set<number>();

interface IpcHandlerRegistry {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

interface HostWebContents {
  readonly id: number;
  once(event: "destroyed", listener: () => void): void;
}

export class HostSnapshotEngineRegistry {
  private readonly entries = new Map<
    number,
    { hostContents: HostWebContents; snapshotEngine: BrowserSnapshotEngine }
  >();

  public get(hostContents: HostWebContents): BrowserSnapshotEngine {
    const existing = this.entries.get(hostContents.id);
    if (existing) {
      return existing.snapshotEngine;
    }
    const snapshotEngine = new BrowserSnapshotEngine();
    const entry = { hostContents, snapshotEngine };
    this.entries.set(hostContents.id, entry);
    hostContents.once("destroyed", () => {
      if (this.entries.get(hostContents.id) === entry) {
        this.entries.delete(hostContents.id);
      }
    });
    return snapshotEngine;
  }
}

const hostSnapshotEngines = new HostSnapshotEngineRegistry();

interface WebContentsDebugger {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  sendCommand(command: string, params?: Record<string, unknown>): Promise<unknown>;
  on?(
    event: "message",
    listener: (event: unknown, method: string, params?: Record<string, unknown>) => void,
  ): void;
}

interface ConsoleMessageEmitter {
  on(
    event: "console-message",
    listener: (
      event: unknown,
      level: unknown,
      message: unknown,
      line: unknown,
      sourceId: unknown,
    ) => void,
  ): void;
  once(event: "destroyed", listener: () => void): void;
}

interface BrowserAutomationWebContents extends ConsoleMessageEmitter {
  readonly id: number;
  readonly debugger: WebContentsDebugger;
  getURL(): string;
  getTitle(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  isLoading(): boolean;
  isDestroyed(): boolean;
  executeJavaScript(code: string): Promise<unknown>;
  loadURL(url: string): Promise<void>;
  goBack(): void;
  goForward(): void;
  reload(): void;
  capturePage(rect?: Rectangle, options?: { stayHidden?: boolean }): Promise<TabImage>;
  invalidate(): void;
  sendInputEvent(event: IsolatedKeyboardInputEvent): void;
}

export function adaptWebContents(contents: BrowserAutomationWebContents): TabContents {
  const contentsId = contents.id;
  observeConsoleMessages(contents, contentsId);
  const cdpQueue = getCdpQueue(contentsId);
  return {
    id: contentsId,
    getURL: () => contents.getURL(),
    getTitle: () => contents.getTitle(),
    canGoBack: () => contents.canGoBack(),
    canGoForward: () => contents.canGoForward(),
    isLoading: () => contents.isLoading(),
    isDestroyed: () => contents.isDestroyed(),
    executeJavaScript: (code: string) => contents.executeJavaScript(code),
    loadURL: (url: string) => contents.loadURL(url),
    goBack: () => contents.goBack(),
    goForward: () => contents.goForward(),
    reload: () => contents.reload(),
    capturePage: (captureOptions) => contents.capturePage(undefined, captureOptions),
    invalidate: () => contents.invalidate(),
    sendInputEvent: (event) => contents.sendInputEvent(event),
    getConsoleMessages: () => consoleMessagesByContentsId.get(contentsId) ?? [],
    captureDialogs: (task) => captureDialogs(contentsId, task),
    getPendingDialog: () => getPendingDialog(contentsId),
    answerDialog: (answer) => answerDialog(contentsId, { ...answer, by: "agent" }),
    drainDialogEvents: () => drainDialogEvents(contentsId),
    sendDebugCommand: (command: string, params?: Record<string, unknown>) =>
      cdpQueue.run(async () => {
        if (!contents.debugger.isAttached()) {
          contents.debugger.attach("1.3");
          // Treat an automated tab as focused so a backgrounded/hidden tab is not
          // throttled — timers, requestAnimationFrame, and layout keep running while
          // the agent drives it, instead of stalling because the tab isn't on screen.
          // Best-effort: ignored on Chromium builds that don't support it.
          try {
            await contents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", {
              enabled: true,
            });
          } catch {
            // Unsupported CDP method — the tab still works, just without focus emulation.
          }
        }
        return contents.debugger.sendCommand(command, params ?? {});
      }),
  };
}

function getCdpQueue(contentsId: number): CdpSessionQueue {
  const existing = cdpQueuesByContentsId.get(contentsId);
  if (existing) {
    return existing;
  }
  const queue = new CdpSessionQueue();
  cdpQueuesByContentsId.set(contentsId, queue);
  return queue;
}

function observeConsoleMessages(contents: BrowserAutomationWebContents, contentsId: number): void {
  if (observedContentsIds.has(contentsId)) {
    return;
  }
  observedContentsIds.add(contentsId);
  contents.on("console-message", (_event, level, message, line, sourceId) => {
    const entry = normalizeConsoleMessage({ level, message, line, sourceId });
    const messages = consoleMessagesByContentsId.get(contentsId) ?? [];
    messages.push(entry);
    consoleMessagesByContentsId.set(contentsId, messages.slice(-MAX_CONSOLE_MESSAGES_PER_TAB));
  });
  contents.once("destroyed", () => {
    observedContentsIds.delete(contentsId);
    consoleMessagesByContentsId.delete(contentsId);
    cdpQueuesByContentsId.delete(contentsId);
  });
}

/**
 * Run a command and report dialogs (ADR-0025). A dialog the command opens blocks the page, and
 * with it the CDP call that triggered it, so the command returns as soon as the dialog opens;
 * the blocked call finishes in the background once the dialog is answered.
 */
async function captureDialogs<T>(contentsId: number, task: () => Promise<T>) {
  const opened = waitForDialog(contentsId);
  const running = task();
  try {
    const outcome = await Promise.race([
      running.then((result) => ({ kind: "result" as const, result })),
      opened.promise.then((pendingDialog) => ({ kind: "dialog" as const, pendingDialog })),
    ]);
    if (outcome.kind === "dialog") {
      running.catch(() => undefined);
      return { dialogs: drainDialogEvents(contentsId), pendingDialog: outcome.pendingDialog };
    }
    return { result: outcome.result, dialogs: drainDialogEvents(contentsId) };
  } finally {
    opened.cancel();
  }
}

function normalizeConsoleMessage(input: {
  level: unknown;
  message: unknown;
  line: unknown;
  sourceId: unknown;
}): BrowserAutomationConsoleLogEntry {
  return {
    level: typeof input.level === "string" ? input.level : String(input.level ?? "log"),
    message: typeof input.message === "string" ? input.message : String(input.message ?? ""),
    ...(typeof input.sourceId === "string" && input.sourceId.length > 0
      ? { source: input.sourceId }
      : {}),
    ...(typeof input.line === "number" ? { line: input.line } : {}),
    timestamp: Date.now(),
  };
}

function createRegistry(hostWebContentsId: number): BrowserRegistry {
  return {
    listRegisteredBrowserIds: listRegisteredJAgentDeskBrowserIds,
    listRegisteredBrowserIdsForWorkspace: listRegisteredJAgentDeskBrowserIdsForWorkspace,
    getTabContents(browserId: string): TabContents | null {
      const contents = getJAgentDeskBrowserWebContentsForHostWindow(browserId, hostWebContentsId);
      return contents ? adaptWebContents(contents) : null;
    },
    getBrowserWorkspaceId: getJAgentDeskBrowserWorkspaceId,
    getWorkspaceActiveBrowserId(workspaceId: string): string | null {
      return getWorkspaceActiveJAgentDeskBrowserIdForHostWindow(workspaceId, hostWebContentsId);
    },
  };
}

export function registerBrowserAutomationIpc(options?: { ipc?: IpcHandlerRegistry }): void {
  const ipc = options?.ipc ?? ipcMain;

  ipc.handle(
    "jagentdesk:browser:execute-automation-command",
    async (event, rawRequest: unknown) => {
      const hostContents = (event as { sender?: HostWebContents }).sender;
      const hostWebContentsId = hostContents?.id;
      if (!hostContents || typeof hostWebContentsId !== "number") {
        return {
          requestId: readRequestId(rawRequest),
          ok: false as const,
          error: {
            code: "browser_unsupported" as const,
            message: "Browser automation requires a host window.",
          },
        };
      }
      const registry = createRegistry(hostWebContentsId);
      const parsed = BrowserAutomationExecuteRequestSchema.safeParse(rawRequest);
      if (!parsed.success) {
        return {
          requestId: readRequestId(rawRequest),
          ok: false as const,
          error: {
            code: "browser_unsupported" as const,
            message: `Invalid automation request: ${parsed.error.message}`,
            retryable: false,
          },
        };
      }
      return executeAutomationCommand(parsed.data, registry, {
        snapshotEngine: hostSnapshotEngines.get(hostContents),
      });
    },
  );
}

function readRequestId(rawRequest: unknown): string {
  if (typeof rawRequest !== "object" || rawRequest === null || Array.isArray(rawRequest)) {
    return "unknown";
  }
  const requestId = (rawRequest as Record<string, unknown>).requestId;
  return typeof requestId === "string" && requestId.length > 0 ? requestId : "unknown";
}
