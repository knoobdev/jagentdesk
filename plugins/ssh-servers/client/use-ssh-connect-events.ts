import { useEffect, useState, useSyncExternalStore } from "react";
import type {
  DaemonClient,
  SshAuthPrompt,
  SshConnectionStateEvent,
  SshHostkeyPrompt,
  SshServerState,
} from "@jagentdesk/client/internal/daemon-client";
import {
  openSshServerFormModel,
  type SshServerFormModel,
  type SshServerFormSnapshot,
} from "./server-form-model";
import {
  openSshIdentityFormModel,
  type SshIdentityFormModel,
  type SshIdentityFormSnapshot,
} from "./identity-form-model";

/** Fresh model per mount (docs/forms.md rule 1: the sheet keys the form component). */
export function useSshServerFormModel(snapshot: SshServerFormSnapshot): {
  model: SshServerFormModel;
  state: ReturnType<SshServerFormModel["getState"]>;
} {
  const [model] = useState(() => openSshServerFormModel(snapshot));
  useEffect(() => () => model.close(), [model]);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  return { model, state };
}

export function useSshIdentityFormModel(snapshot: SshIdentityFormSnapshot): {
  model: SshIdentityFormModel;
  state: ReturnType<SshIdentityFormModel["getState"]>;
} {
  const [model] = useState(() => openSshIdentityFormModel(snapshot));
  useEffect(() => () => model.close(), [model]);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  return { model, state };
}

/** Per-server live connect picture assembled from the three ssh.* pushes. */
export interface SshServerLiveState {
  connection: SshConnectionStateEvent | null;
  hostkeyPrompt: SshHostkeyPrompt | null;
  /** This client's answer, once sent; the bar shows "pending" until the state moves. */
  hostkeyDecision: "accept" | "reject" | null;
  authPrompt: SshAuthPrompt | null;
  /** True once this client submitted the auth answers; fields are already cleared. */
  authSubmitted: boolean;
}

const EMPTY_LIVE_STATE: SshServerLiveState = {
  connection: null,
  hostkeyPrompt: null,
  hostkeyDecision: null,
  authPrompt: null,
  authSubmitted: false,
};

export type SshDotTone = "green" | "yellow" | "red" | "muted";

/** State dot tone for a server row / terminal header (spec 25.13). */
export function sshStateTone(state: SshServerState | undefined): SshDotTone {
  switch (state) {
    case "connected":
      return "green";
    case "awaiting_hostkey":
    case "awaiting_auth":
      return "yellow";
    case "error":
    case "reconnecting":
      return "red";
    default:
      return "muted";
  }
}

/** The most informative connect status to render for a server, live push first. */
export function sshLiveStatusLabel(live: SshServerLiveState | undefined): string | null {
  if (!live) return null;
  if (live.hostkeyPrompt && !live.hostkeyDecision) return "Waiting for host key approval";
  if (live.hostkeyDecision) return live.hostkeyDecision === "accept" ? "Accepting…" : "Rejecting…";
  if (live.authPrompt && !live.authSubmitted) return "Waiting for credentials";
  if (live.authSubmitted) return "Authenticating…";
  switch (live.connection?.state) {
    case "connecting":
      return "Connecting…";
    case "connected":
      return "Connected";
    case "reconnecting":
      return "Connection lost — reconnecting…";
    case "error":
      return live.connection.error?.message ?? "Connection failed";
    default:
      return null;
  }
}

/**
 * Subscribes to `ssh.hostkey.prompt`, `ssh.auth.prompt`, and `ssh.connection.state`
 * once per client and exposes them keyed by serverId. Answers are sent through the
 * daemon (`sshHostkeyRespond` / `sshAuthRespond`) and never stored: auth field values
 * live in the prompt-bar component and are cleared on submit.
 */
export function useSshConnectEvents(client: DaemonClient | null): {
  liveByServerId: Readonly<Record<string, SshServerLiveState>>;
  /** Last connection state per SSH terminal tab (tab dot + status line). */
  stateByTerminalId: Readonly<Record<string, SshConnectionStateEvent>>;
  respondHostkey: (serverId: string, decision: "accept" | "reject") => void;
  respondAuth: (serverId: string, answers: string[] | null) => void;
  clear: (serverId: string) => void;
} {
  const [liveByServerId, setLiveByServerId] = useState<Record<string, SshServerLiveState>>({});
  const [stateByTerminalId, setStateByTerminalId] = useState<
    Record<string, SshConnectionStateEvent>
  >({});

  useEffect(() => {
    if (!client) {
      setLiveByServerId({});
      return;
    }
    const patch = (serverId: string, next: Partial<SshServerLiveState>) => {
      setLiveByServerId((current) => ({
        ...current,
        [serverId]: { ...(current[serverId] ?? EMPTY_LIVE_STATE), ...next },
      }));
    };
    const offHostkey = client.onSshHostkeyPrompt((prompt) => {
      patch(prompt.serverId, {
        hostkeyPrompt: prompt,
        hostkeyDecision: null,
      });
    });
    const offAuth = client.onSshAuthPrompt((prompt) => {
      patch(prompt.serverId, { authPrompt: prompt, authSubmitted: false });
    });
    // Answered on another device, expired, or abandoned: drop the bar everywhere.
    const offResolved = client.onSshPromptResolved(({ promptId }) => {
      setLiveByServerId((current) => {
        let changed = false;
        const next: Record<string, SshServerLiveState> = {};
        for (const [serverId, live] of Object.entries(current)) {
          const dropHostkey = live.hostkeyPrompt?.promptId === promptId;
          const dropAuth = live.authPrompt?.promptId === promptId;
          changed ||= dropHostkey || dropAuth;
          next[serverId] = {
            ...live,
            ...(dropHostkey ? { hostkeyPrompt: null, hostkeyDecision: null } : {}),
            ...(dropAuth ? { authPrompt: null, authSubmitted: false } : {}),
          };
        }
        return changed ? next : current;
      });
    });
    const offState = client.onSshConnectionState((event) => {
      const terminalId = event.terminalId;
      if (terminalId) {
        setStateByTerminalId((current) => ({ ...current, [terminalId]: event }));
        // Terminal-scoped pushes only drive the tab; the server row follows server-level ones.
        if (event.state !== "awaiting_hostkey" && event.state !== "awaiting_auth") return;
      }
      setLiveByServerId((current) => {
        const live = current[event.serverId] ?? EMPTY_LIVE_STATE;
        const settled =
          event.state === "connected" || event.state === "error" || event.state === "disconnected";
        const next: SshServerLiveState = {
          ...live,
          connection: event,
          // Prompts only matter until the connect settles; the state push closes them.
          hostkeyPrompt: settled ? null : live.hostkeyPrompt,
          hostkeyDecision: settled ? null : live.hostkeyDecision,
          authPrompt: settled ? null : live.authPrompt,
          authSubmitted: settled ? false : live.authSubmitted,
        };
        return { ...current, [event.serverId]: next };
      });
    });
    return () => {
      offHostkey();
      offAuth();
      offResolved();
      offState();
    };
  }, [client]);

  const respondHostkey = (serverId: string, decision: "accept" | "reject") => {
    if (!client) return;
    const prompt = liveByServerId[serverId]?.hostkeyPrompt;
    if (!prompt || liveByServerId[serverId]?.hostkeyDecision) return;
    // First answer wins daemon-side; reflect the pending answer immediately.
    setLiveByServerId((current) => ({
      ...current,
      [serverId]: { ...(current[serverId] ?? EMPTY_LIVE_STATE), hostkeyDecision: decision },
    }));
    void client.sshHostkeyRespond({ promptId: prompt.promptId, decision }).catch(() => {
      // The daemon answers prompts once; a failed respond means the prompt already
      // expired or another client answered. The state push settles the UI.
    });
  };

  const respondAuth = (serverId: string, answers: string[] | null) => {
    if (!client) return;
    const prompt = liveByServerId[serverId]?.authPrompt;
    if (!prompt || liveByServerId[serverId]?.authSubmitted) return;
    setLiveByServerId((current) => ({
      ...current,
      [serverId]: { ...(current[serverId] ?? EMPTY_LIVE_STATE), authSubmitted: true },
    }));
    void client.sshAuthRespond({ promptId: prompt.promptId, answers }).catch(() => {
      // Same as hostkey: the connection-state push is the source of truth.
    });
  };

  const clear = (serverId: string) => {
    setLiveByServerId((current) => {
      if (!current[serverId]) return current;
      const next = { ...current };
      delete next[serverId];
      return next;
    });
  };

  return { liveByServerId, stateByTerminalId, respondHostkey, respondAuth, clear };
}
