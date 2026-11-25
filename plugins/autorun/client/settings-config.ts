import type { MutableDaemonConfig } from "@jagentdesk/protocol/messages";

// Autonomous run opt-in card (spec §20.12). Default OFF; enabling lets an agent run
// unattended across many turns until a budget or the objective stops it. The daemon
// only exposes the autorun.* surface when this is on at startup, so the hint notes the
// restart requirement.
export const AUTORUN_TITLE = "Autonomous run";
export const AUTORUN_WARNING =
  "Allow agents to run unattended across many turns until a budget or the objective stops them. Only enable for agents you trust. Takes effect after the daemon restarts.";

export interface AutorunCardState {
  isVisible: boolean;
  isEnabled: boolean;
  title: string;
  warning: string;
}

export interface AutorunMutationViewState {
  isSwitchDisabled: boolean;
  loadingText: string | null;
  errorText: string | null;
}

export function getAutorunCardState(input: {
  isConnected: boolean;
  config: MutableDaemonConfig | null;
}): AutorunCardState {
  return {
    isVisible: input.isConnected,
    isEnabled: input.config?.autorun?.enabled === true,
    title: AUTORUN_TITLE,
    warning: AUTORUN_WARNING,
  };
}

export function createAutorunPatch(enabled: boolean): Partial<MutableDaemonConfig> {
  return { autorun: { enabled } };
}

export function getAutorunMutationViewState(input: {
  isPending: boolean;
  error: unknown;
}): AutorunMutationViewState {
  return {
    isSwitchDisabled: input.isPending,
    loadingText: input.isPending ? "Updating autonomous run…" : null,
    errorText: input.error ? toErrorMessage(input.error) : null,
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
