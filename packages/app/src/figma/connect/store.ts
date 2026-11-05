import { parseFigmaCallbackUrl } from "@/figma/url-parse";

// Client-side state for the Figma connect surface (spec 32.2): the OAuth attempt in flight and
// the client ID/secret draft, per serverId. The connect screen reads it through
// useSyncExternalStore; delegated sign-ins (figma.oauth.delegation) are handled directly by
// FigmaOAuthDelegationBinder, mirroring Jira.

export type FigmaConnectPhase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "browser-opened"; attemptId: string; authorizeUrl: string; redirectUri: string }
  | { kind: "finishing" }
  | { kind: "error"; message: string };

export interface FigmaConnectState {
  phase: FigmaConnectPhase;
  clientId: string;
  clientSecret: string;
  signedInLabel: string | null;
}

const IDLE: FigmaConnectState = {
  phase: { kind: "idle" },
  clientId: "",
  clientSecret: "",
  signedInLabel: null,
};

const states = new Map<string, FigmaConnectState>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function setState(serverId: string, next: FigmaConnectState): void {
  states.set(serverId, next);
  emit();
}

export function getFigmaConnectState(serverId: string): FigmaConnectState {
  return states.get(serverId) ?? IDLE;
}

export function subscribeFigmaConnect(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setFigmaConnectDraft(
  serverId: string,
  draft: { clientId?: string; clientSecret?: string },
): void {
  const current = getFigmaConnectState(serverId);
  setState(serverId, {
    ...current,
    clientId: draft.clientId ?? current.clientId,
    clientSecret: draft.clientSecret ?? current.clientSecret,
    phase: current.phase.kind === "error" ? { kind: "idle" } : current.phase,
  });
}

export function resetFigmaConnect(serverId: string): void {
  const current = getFigmaConnectState(serverId);
  setState(serverId, {
    ...IDLE,
    clientId: current.clientId,
    clientSecret: current.clientSecret,
  });
}

export interface FigmaBeginResult {
  attemptId: string;
  authorizeUrl: string;
  redirectUri: string;
}

interface FigmaConnectOps {
  begin: (input: {
    clientId: string;
    clientSecret: string;
    redirect: "loopback" | "paste";
  }) => Promise<FigmaBeginResult>;
  complete: (input: {
    attemptId: string;
    code?: string;
    state?: string;
    pastedUrl?: string;
  }) => Promise<{ connected: boolean }>;
  runLoopback: (
    begin: FigmaBeginResult,
  ) => Promise<{ kind: "connected" } | { kind: "error"; message: string }>;
  delegate: (input: {
    clientId: string;
    clientSecret: string;
  }) => Promise<{ attemptId: string | null; desktopAvailable: boolean }>;
}

let ops: FigmaConnectOps | null = null;

export function configureFigmaConnect(nextOps: FigmaConnectOps | null): void {
  ops = nextOps;
}

function requireOps(): FigmaConnectOps {
  if (!ops) throw new Error("Figma connect is not configured.");
  return ops;
}

function missingCredentials(state: FigmaConnectState): boolean {
  return !state.clientId.trim() || !state.clientSecret.trim();
}

function failCurrent(serverId: string, message: unknown): void {
  setState(serverId, {
    ...getFigmaConnectState(serverId),
    phase: { kind: "error", message: message instanceof Error ? message.message : String(message) },
  });
}

// Desktop: begin with the loopback redirect, hand the authorize URL to Electron, which serves
// 127.0.0.1:8766 and opens the system browser itself (mirrors the Jira desktop flow).
export async function startFigmaBrowserSignIn(serverId: string): Promise<void> {
  const current = getFigmaConnectState(serverId);
  if (missingCredentials(current)) {
    setState(serverId, {
      ...current,
      phase: {
        kind: "error",
        message: "Enter the Client ID and Client Secret from your Figma app.",
      },
    });
    return;
  }
  setState(serverId, { ...current, phase: { kind: "starting" } });
  try {
    const begun = await requireOps().begin({
      clientId: current.clientId.trim(),
      clientSecret: current.clientSecret.trim(),
      redirect: "loopback",
    });
    setState(serverId, { ...getFigmaConnectState(serverId), phase: { kind: "finishing" } });
    const outcome = await requireOps().runLoopback(begun);
    const previous = getFigmaConnectState(serverId);
    setState(serverId, {
      ...previous,
      signedInLabel:
        outcome.kind === "connected" ? previous.clientId.trim() : previous.signedInLabel,
      phase:
        outcome.kind === "connected"
          ? { kind: "idle" }
          : { kind: "error", message: outcome.message },
    });
  } catch (error) {
    failCurrent(serverId, error);
  }
}

// Non-desktop: begin with the paste redirect; the screen then offers the authorize link and the
// final-URL field. The browser lands on the loopback URL with nothing listening — the user copies
// that address back here.
export async function startFigmaPasteSignIn(serverId: string): Promise<void> {
  const current = getFigmaConnectState(serverId);
  if (missingCredentials(current)) {
    setState(serverId, {
      ...current,
      phase: {
        kind: "error",
        message: "Enter the Client ID and Client Secret from your Figma app.",
      },
    });
    return;
  }
  setState(serverId, { ...current, phase: { kind: "starting" } });
  try {
    const begun = await requireOps().begin({
      clientId: current.clientId.trim(),
      clientSecret: current.clientSecret.trim(),
      redirect: "paste",
    });
    setState(serverId, {
      ...getFigmaConnectState(serverId),
      phase: {
        kind: "browser-opened",
        attemptId: begun.attemptId,
        authorizeUrl: begun.authorizeUrl,
        redirectUri: begun.redirectUri,
      },
    });
  } catch (error) {
    failCurrent(serverId, error);
  }
}

export async function submitFigmaPastedUrl(serverId: string, callbackUrl: string): Promise<void> {
  const current = getFigmaConnectState(serverId);
  if (current.phase.kind !== "browser-opened") return;
  const { attemptId } = current.phase;
  const parsed = parseFigmaCallbackUrl(callbackUrl);
  if (parsed.kind === "error") {
    setState(serverId, { ...current, phase: { kind: "error", message: parsed.message } });
    return;
  }
  setState(serverId, { ...current, phase: { kind: "finishing" } });
  try {
    const outcome = await requireOps().complete({
      attemptId,
      code: parsed.code,
      state: parsed.state,
    });
    const previous = getFigmaConnectState(serverId);
    setState(serverId, {
      ...previous,
      signedInLabel: outcome.connected ? previous.clientId.trim() : previous.signedInLabel,
      phase: outcome.connected
        ? { kind: "idle" }
        : { kind: "error", message: "Figma rejected the sign-in." },
    });
  } catch (error) {
    failCurrent(serverId, error);
  }
}

// Mobile: ask a paired online desktop to run the browser step (32.2).
export async function requestFigmaDelegatedSignIn(
  serverId: string,
): Promise<"sent" | "no-desktop" | "missing" | "error"> {
  const current = getFigmaConnectState(serverId);
  if (missingCredentials(current)) return "missing";
  try {
    const response = await requireOps().delegate({
      clientId: current.clientId.trim(),
      clientSecret: current.clientSecret.trim(),
    });
    if (!response.desktopAvailable) return "no-desktop";
    return response.attemptId ? "sent" : "error";
  } catch {
    return "error";
  }
}
