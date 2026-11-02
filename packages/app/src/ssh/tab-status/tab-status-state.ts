import type { SshServerState } from "@jagentdesk/protocol/ssh/rpc-schemas";

export type SshTabDotStatus = "unseen_output" | "awaiting_input" | "error" | "idle";

export interface SshTabStatusState {
  connection: SshServerState | null;
  everConnected: boolean;
  pendingPromptIds: readonly string[];
  unseenOutput: boolean;
  focused: boolean;
}

export interface SshTabOutputEvent {
  type: "output";
}

export interface SshTabFocusedEvent {
  type: "focused";
}

export interface SshTabBlurredEvent {
  type: "blurred";
}

export interface SshTabHostkeyPromptEvent {
  type: "hostkey_prompt";
  promptId: string;
}

export interface SshTabAuthPromptEvent {
  type: "auth_prompt";
  promptId: string;
}

export interface SshTabPromptResolvedEvent {
  type: "prompt_resolved";
  promptId: string;
}

export interface SshTabConnectionEvent {
  type: "connection";
  state: SshServerState;
}

export type SshTabEvent =
  | SshTabOutputEvent
  | SshTabFocusedEvent
  | SshTabBlurredEvent
  | SshTabHostkeyPromptEvent
  | SshTabAuthPromptEvent
  | SshTabPromptResolvedEvent
  | SshTabConnectionEvent;

export const initialSshTabStatusState: SshTabStatusState = {
  connection: null,
  everConnected: false,
  pendingPromptIds: [],
  unseenOutput: false,
  focused: false,
};

/**
 * Spec 25.4 tab status dot: green = unseen output, yellow = waiting for input
 * (host key or auth prompt), red = error/lost connection.
 */
export function sshTabStatus(state: SshTabStatusState, event: SshTabEvent): SshTabStatusState {
  switch (event.type) {
    case "output":
      if (state.focused) {
        return state;
      }
      return { ...state, unseenOutput: true };
    case "focused":
      return { ...state, focused: true, unseenOutput: false };
    case "blurred":
      return { ...state, focused: false };
    case "hostkey_prompt":
    case "auth_prompt":
      return addPendingPrompt(state, event.promptId);
    case "prompt_resolved":
      return removePendingPrompt(state, event.promptId);
    case "connection":
      return applyConnectionState(state, event.state);
  }
}

export function deriveSshTabDotStatus(state: SshTabStatusState): SshTabDotStatus {
  if (isAwaitingInput(state)) {
    return "awaiting_input";
  }
  if (isConnectionLost(state)) {
    return "error";
  }
  if (state.unseenOutput) {
    return "unseen_output";
  }
  return "idle";
}

function isAwaitingInput(state: SshTabStatusState): boolean {
  const promptOnConnection =
    state.connection === "awaiting_hostkey" || state.connection === "awaiting_auth";
  return state.pendingPromptIds.length > 0 || promptOnConnection;
}

function isConnectionLost(state: SshTabStatusState): boolean {
  if (state.connection === "error") {
    return true;
  }
  const dropped = state.connection === "disconnected" || state.connection === "reconnecting";
  return dropped && state.everConnected;
}

function addPendingPrompt(state: SshTabStatusState, promptId: string): SshTabStatusState {
  if (state.pendingPromptIds.includes(promptId)) {
    return state;
  }
  return { ...state, pendingPromptIds: [...state.pendingPromptIds, promptId] };
}

function removePendingPrompt(state: SshTabStatusState, promptId: string): SshTabStatusState {
  if (!state.pendingPromptIds.includes(promptId)) {
    return state;
  }
  return { ...state, pendingPromptIds: state.pendingPromptIds.filter((id) => id !== promptId) };
}

function applyConnectionState(
  state: SshTabStatusState,
  connection: SshServerState,
): SshTabStatusState {
  const everConnected = state.everConnected || connection === "connected";
  return { ...state, connection, everConnected };
}
