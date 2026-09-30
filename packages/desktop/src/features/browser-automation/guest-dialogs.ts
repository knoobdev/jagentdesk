import { randomUUID } from "node:crypto";
import type {
  BrowserAutomationDialogEvent,
  BrowserAutomationPendingDialog,
} from "@jagentdesk/protocol/browser-automation/rpc-schemas";

/**
 * JavaScript dialogs of agentic-browser tabs (ADR-0025). Electron shows alert/confirm as a
 * native window over the app (its default `-run-dialog` handler), and its renderer replaces
 * the main frame's prompt() with a stub that throws (lib/renderer/window-setup.ts). For
 * agentic tabs that handler is replaced and the guest preload routes prompt() here: the dialog
 * becomes the tab's pending dialog, the page stays blocked, and the agent (browser_dialog) or
 * the user (the bar in the tab) answers it. Nothing is answered automatically.
 */

type DialogType = BrowserAutomationPendingDialog["type"];

/** What Electron passes to `-run-dialog` (lib/browser/api/web-contents.ts, v41). */
interface RunDialogInfo {
  dialogType?: unknown;
  messageText?: unknown;
  defaultPromptText?: unknown;
  frame?: { url?: unknown } | null;
}
type RunDialogCallback = (success: boolean, userInput: string) => void;

export interface DialogGuestContents {
  readonly id: number;
  getURL(): string;
  isDestroyed(): boolean;
  on(event: string, listener: (...args: never[]) => void): unknown;
  removeAllListeners(event: string): unknown;
  once(event: "destroyed", listener: () => void): unknown;
}

interface PendingEntry {
  dialog: BrowserAutomationPendingDialog;
  respond: RunDialogCallback;
}

export interface DialogAnswer {
  action: "accept" | "dismiss";
  text?: string;
  by: "agent" | "user";
}

export interface DialogsChange {
  contentsId: number;
  pendingDialog: BrowserAutomationPendingDialog | null;
}

const MAX_EVENTS_PER_TAB = 20;
const pending = new Map<number, PendingEntry>();
const recentEvents = new Map<number, BrowserAutomationDialogEvent[]>();
const installed = new WeakSet<object>();
const openedListeners = new Set<
  (contentsId: number, dialog: BrowserAutomationPendingDialog) => void
>();
const changeListeners = new Set<(change: DialogsChange) => void>();

function dialogType(value: unknown): DialogType {
  return value === "confirm" || value === "prompt" ? value : "alert";
}

function recordEvent(contentsId: number, event: BrowserAutomationDialogEvent): void {
  const events = recentEvents.get(contentsId) ?? [];
  events.push(event);
  recentEvents.set(contentsId, events.slice(-MAX_EVENTS_PER_TAB));
}

function notifyChange(contentsId: number): void {
  const change = { contentsId, pendingDialog: pending.get(contentsId)?.dialog ?? null };
  for (const listener of changeListeners) listener(change);
}

function openDialog(
  contentsId: number,
  dialog: Omit<BrowserAutomationPendingDialog, "id" | "openedAtMs">,
  respond: RunDialogCallback,
): void {
  // A page cannot open a second dialog while one is showing; if it happens, the old one
  // is gone (navigation), so it is dropped.
  pending.get(contentsId)?.respond(false, "");
  const opened: BrowserAutomationPendingDialog = {
    id: randomUUID(),
    ...dialog,
    openedAtMs: Date.now(),
  };
  pending.set(contentsId, { dialog: opened, respond });
  for (const listener of openedListeners) listener(contentsId, opened);
  notifyChange(contentsId);
}

/** Route a guest's dialogs here instead of Electron's native message box. Idempotent. */
export function installGuestDialogHandler(contents: DialogGuestContents): void {
  if (installed.has(contents)) return;
  installed.add(contents);
  const contentsId = contents.id;
  contents.removeAllListeners("-run-dialog");
  contents.on("-run-dialog", ((info: RunDialogInfo, callback: RunDialogCallback) => {
    const type = dialogType(info.dialogType);
    openDialog(
      contentsId,
      {
        type,
        message: typeof info.messageText === "string" ? info.messageText : "",
        ...(type === "prompt" && typeof info.defaultPromptText === "string"
          ? { defaultValue: info.defaultPromptText }
          : {}),
        url: typeof info.frame?.url === "string" ? info.frame.url : contents.getURL(),
      },
      callback,
    );
  }) as never);
  // Electron cancels dialogs on navigation or when the frame goes away. The page is released
  // too: a prompt() waiting on the guest preload's sync IPC would otherwise stay blocked.
  contents.on("-cancel-dialogs", (() => {
    const entry = pending.get(contentsId);
    if (!entry) return;
    pending.delete(contentsId);
    entry.respond(false, "");
    notifyChange(contentsId);
  }) as never);
  // beforeunload ("Leave site?") can only be decided synchronously: agentic tabs leave, and
  // the next command tells the agent.
  contents.on("will-prevent-unload", ((event: { preventDefault(): void }) => {
    event.preventDefault();
    recordEvent(contentsId, {
      type: "beforeunload",
      message: "The page asked to confirm leaving; it was left.",
      action: "accepted",
      timestamp: Date.now(),
    });
  }) as never);
  contents.once("destroyed", () => {
    pending.delete(contentsId);
    recentEvents.delete(contentsId);
    notifyChange(contentsId);
  });
}

/**
 * prompt() of an agentic tab's main frame, relayed by the guest preload. Returns false when
 * `contents` is not an agentic tab, so the caller answers as Electron would (no value).
 */
export function openGuestPrompt(
  contents: DialogGuestContents,
  input: { message: string; defaultValue: string },
  respond: RunDialogCallback,
): boolean {
  if (!installed.has(contents)) return false;
  openDialog(
    contents.id,
    {
      type: "prompt",
      message: input.message,
      defaultValue: input.defaultValue,
      url: contents.getURL(),
    },
    respond,
  );
  return true;
}

export function getPendingDialog(contentsId: number): BrowserAutomationPendingDialog | null {
  return pending.get(contentsId)?.dialog ?? null;
}

/**
 * Answer the tab's pending dialog. Returns what was answered, or null when none is open
 * (already answered by someone else, or the page navigated away).
 */
export function answerDialog(
  contentsId: number,
  answer: DialogAnswer,
): BrowserAutomationDialogEvent | null {
  const entry = pending.get(contentsId);
  if (!entry) return null;
  pending.delete(contentsId);
  const accept = answer.action === "accept";
  const text =
    entry.dialog.type === "prompt" && accept
      ? (answer.text ?? entry.dialog.defaultValue ?? "")
      : "";
  entry.respond(accept, text);
  const event: BrowserAutomationDialogEvent = {
    type: entry.dialog.type,
    message: entry.dialog.message,
    ...(entry.dialog.defaultValue !== undefined ? { defaultValue: entry.dialog.defaultValue } : {}),
    action: accept ? "accepted" : "dismissed",
    ...(entry.dialog.type === "prompt" && accept ? { promptText: text } : {}),
    timestamp: Date.now(),
  };
  // A user's answer is reported to the agent with its next command on this tab.
  if (answer.by === "user") recordEvent(contentsId, event);
  notifyChange(contentsId);
  return event;
}

/** Dialog events since the last command (user answers, beforeunload). */
export function drainDialogEvents(contentsId: number): BrowserAutomationDialogEvent[] {
  const events = recentEvents.get(contentsId) ?? [];
  recentEvents.delete(contentsId);
  return events;
}

/** Resolves when `contentsId` opens a dialog; `cancel` stops waiting. */
export function waitForDialog(contentsId: number): {
  promise: Promise<BrowserAutomationPendingDialog>;
  cancel(): void;
} {
  let listener: ((id: number, dialog: BrowserAutomationPendingDialog) => void) | null = null;
  const promise = new Promise<BrowserAutomationPendingDialog>((resolve) => {
    listener = (id, dialog) => {
      if (id === contentsId) resolve(dialog);
    };
    openedListeners.add(listener);
  });
  return {
    promise,
    cancel: () => {
      if (listener) openedListeners.delete(listener);
    },
  };
}

/** Pending-dialog changes, for the dialog bar in the app. */
export function onDialogsChanged(listener: (change: DialogsChange) => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}
