import { useEffect, useState } from "react";
import type { DaemonClient, SshSessionInfo } from "@jagentdesk/client/internal/daemon-client";
import type { SshDotTone } from "@/ssh/use-ssh-connect-events";
import {
  deriveSshTabDotStatus,
  initialSshTabStatusState,
  sshTabStatus,
  type SshTabDotStatus,
  type SshTabEvent,
  type SshTabStatusState,
} from "./tab-status-state";

// Feeds the tab-status state machine (spec 25.4 dots) from the daemon pushes: output
// activity, host-key / auth prompts and their resolution, and connection state. The tab
// the user is looking at is "focused", so its output never turns it green.

const DOT_TONES: Record<SshTabDotStatus, SshDotTone> = {
  unseen_output: "green",
  awaiting_input: "yellow",
  error: "red",
  idle: "muted",
};

export function sshTabDotTone(state: SshTabStatusState | undefined): SshDotTone {
  const tone = DOT_TONES[deriveSshTabDotStatus(state ?? initialSshTabStatusState)];
  // A connected tab with nothing unseen still reads as live (25.13.1 dot colors).
  return tone === "muted" && state?.connection === "connected" ? "green" : tone;
}

type Statuses = Readonly<Record<string, SshTabStatusState>>;

function apply(statuses: Statuses, terminalId: string, event: SshTabEvent): Statuses {
  const current = statuses[terminalId] ?? initialSshTabStatusState;
  const next = sshTabStatus(current, event);
  return next === current ? statuses : { ...statuses, [terminalId]: next };
}

function applyToAll(statuses: Statuses, event: SshTabEvent): Statuses {
  let next = statuses;
  for (const terminalId of Object.keys(statuses)) next = apply(next, terminalId, event);
  return next;
}

/** Prompts carry the terminal that started the connect; others wait on the same server. */
function terminalsFor(
  sessions: readonly SshSessionInfo[],
  serverId: string,
  terminalId: string | undefined,
): string[] {
  if (terminalId) return [terminalId];
  return sessions.filter((session) => session.serverId === serverId).map((s) => s.terminalId);
}

export function useSshTabStatuses(input: {
  client: DaemonClient | null;
  sessions: readonly SshSessionInfo[];
  focusedTerminalId: string | null;
}): Statuses {
  const { client, sessions, focusedTerminalId } = input;
  const [statuses, setStatuses] = useState<Statuses>({});

  useEffect(() => {
    if (!client) return undefined;
    const update = (terminalIds: readonly string[], event: SshTabEvent) =>
      setStatuses((current) =>
        terminalIds.reduce((acc, terminalId) => apply(acc, terminalId, event), current),
      );
    const offs = [
      client.onSshSessionActivity((event) => update([event.terminalId], { type: "output" })),
      client.onSshHostkeyPrompt((prompt) =>
        update(terminalsFor(sessions, prompt.serverId, prompt.terminalId), {
          type: "hostkey_prompt",
          promptId: prompt.promptId,
        }),
      ),
      client.onSshAuthPrompt((prompt) =>
        update(terminalsFor(sessions, prompt.serverId, prompt.terminalId), {
          type: "auth_prompt",
          promptId: prompt.promptId,
        }),
      ),
      client.onSshPromptResolved(({ promptId }) =>
        setStatuses((current) => applyToAll(current, { type: "prompt_resolved", promptId })),
      ),
      client.onSshConnectionState((event) => {
        if (event.terminalId)
          update([event.terminalId], { type: "connection", state: event.state });
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [client, sessions]);

  // Seed tabs found in the session list (app reopened) and track focus.
  useEffect(() => {
    setStatuses((current) => {
      let next = current;
      for (const session of sessions) {
        if (!next[session.terminalId]) {
          next = apply(next, session.terminalId, { type: "connection", state: session.state });
        }
        const focused = session.terminalId === focusedTerminalId;
        if ((next[session.terminalId]?.focused ?? false) !== focused) {
          next = apply(next, session.terminalId, { type: focused ? "focused" : "blurred" });
        }
      }
      return next;
    });
  }, [focusedTerminalId, sessions]);

  return statuses;
}
