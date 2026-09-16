import type { MutableDaemonConfig } from "@jagentdesk/protocol/messages";

// Session-sharing opt-in card (spec §21.11 / ADR-0018). Default OFF; enabling lets the host
// expose a single agent's chat as a public Cloudflare-tunnel web link that a guest can join
// (with the host's approval + a 6-digit code). The daemon only exposes the session.share.*
// surface + the Share button when this is on at startup, so the hint notes the restart.
export const SESSION_SHARE_TITLE = "Session sharing";
export const SESSION_SHARE_WARNING =
  "Allow sharing an agent's chat as a public web link a guest can join to chat with that agent. Guests need your approval and a 6-digit code, and dangerous actions still ask you here. Only enable when you need it. Takes effect after the daemon restarts.";

export interface SessionShareCardState {
  isVisible: boolean;
  isEnabled: boolean;
  title: string;
  warning: string;
}

export interface SessionShareMutationViewState {
  isSwitchDisabled: boolean;
  loadingText: string | null;
  errorText: string | null;
}

export function getSessionShareCardState(input: {
  isConnected: boolean;
  config: MutableDaemonConfig | null;
}): SessionShareCardState {
  return {
    isVisible: input.isConnected,
    isEnabled: input.config?.sessionSharing?.enabled === true,
    title: SESSION_SHARE_TITLE,
    warning: SESSION_SHARE_WARNING,
  };
}

export function createSessionSharePatch(enabled: boolean): Partial<MutableDaemonConfig> {
  return { sessionSharing: { enabled } };
}

export function getSessionShareMutationViewState(input: {
  isPending: boolean;
  error: unknown;
}): SessionShareMutationViewState {
  return {
    isSwitchDisabled: input.isPending,
    loadingText: input.isPending ? "Updating session sharing…" : null,
    errorText: input.error ? toErrorMessage(input.error) : null,
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
