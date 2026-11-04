import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { ArgoCdErrorCode, ArgoCdInstance } from "@jagentdesk/protocol/argocd/rpc-schemas";
import { getDesktopHost, type DesktopArgoCdBridge } from "@/desktop/host";

// Argo CD SSO (spec 30.2.1 desktop, 30.2.2 mobile via a paired desktop). The PKCE verifier
// stays in the daemon; the desktop only relays `code` + `state` from the loopback listener.

export type ArgoCdSsoOutcome =
  | { ok: true; instance: ArgoCdInstance | null }
  | { ok: false; errorCode: ArgoCdErrorCode | null; message: string };

export function getDesktopSsoBridge(): DesktopArgoCdBridge | null {
  return getDesktopHost()?.argocd ?? null;
}

const IDP_HINT =
  "If the identity provider does not allow the localhost redirect for the CLI client, sign in with an API token instead.";

/** Runs the whole desktop flow: begin → loopback in the system browser → complete. */
export async function runDesktopSso(
  client: DaemonClient,
  bridge: DesktopArgoCdBridge,
  instanceId: string,
): Promise<ArgoCdSsoOutcome> {
  const begin = await client.argocd("argocd.sso.begin.request", { id: instanceId });
  if (begin.error || !begin.authUrl || !begin.state) {
    return {
      ok: false,
      errorCode: begin.errorCode,
      message: begin.error ?? "Argo CD did not return a sign-in URL",
    };
  }
  const state = begin.state;
  const timeoutMs = begin.expiresAt_ms ? Math.max(begin.expiresAt_ms - Date.now(), 1_000) : 300_000;
  const loopback = await bridge.ssoLoopback({ authUrl: begin.authUrl, state, timeoutMs });
  if (!loopback.ok) {
    // Tell the daemon so it drops the pending flow and its verifier.
    await client.argocd("argocd.sso.complete.request", {
      id: instanceId,
      state,
      errorCode: loopback.errorCode,
      error: loopback.error ?? loopback.message,
      errorDescription: loopback.errorDescription,
    });
    const message =
      loopback.errorCode === "sso_idp_error" ? `${loopback.message} ${IDP_HINT}` : loopback.message;
    return { ok: false, errorCode: loopback.errorCode, message };
  }
  const complete = await client.argocd("argocd.sso.complete.request", {
    id: instanceId,
    state: loopback.state,
    code: loopback.code,
  });
  if (complete.error) {
    const message =
      complete.errorCode === "sso_idp_error" ? `${complete.error} ${IDP_HINT}` : complete.error;
    return { ok: false, errorCode: complete.errorCode, message };
  }
  return { ok: true, instance: complete.instance };
}
