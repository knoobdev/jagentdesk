import type { FocusDirection } from "./split-layout";

// Workspace shortcuts from the Termius inventory (§4 Workspaces, Broadcast input):
// broadcast is Cmd+B on macOS and Ctrl+Alt+B elsewhere; moving between panes is
// Cmd+Opt+arrows / Ctrl+Alt+arrows.

export interface ShortcutKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export type SplitShortcutAction =
  | { kind: "toggle-broadcast" }
  | { kind: "focus"; direction: FocusDirection };

const ARROWS: Readonly<Record<string, FocusDirection>> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

export function splitShortcutFor(
  event: ShortcutKeyEvent,
  platform: { isMac: boolean },
): SplitShortcutAction | null {
  if (event.shiftKey) return null;
  const broadcastChord = platform.isMac
    ? event.metaKey && !event.ctrlKey && !event.altKey
    : event.ctrlKey && event.altKey && !event.metaKey;
  if (broadcastChord && event.key.toLowerCase() === "b") return { kind: "toggle-broadcast" };
  const paneChord = platform.isMac
    ? event.metaKey && event.altKey && !event.ctrlKey
    : event.ctrlKey && event.altKey && !event.metaKey;
  const direction = ARROWS[event.key];
  if (paneChord && direction) return { kind: "focus", direction };
  return null;
}
