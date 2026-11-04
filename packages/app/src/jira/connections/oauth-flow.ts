import type { JiraConnection, JiraOAuthSite } from "@jagentdesk/protocol/jira/rpc-schemas";
import { getIsElectron } from "@/constants/platform";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import type { JiraCall } from "../api";

// The browser half of Jira OAuth (spec 29.1.1): on the desktop app a loopback listener in Electron
// catches the callback; everywhere the user can paste the URL the browser landed on instead.

export type LoopbackResult =
  | { kind: "code"; code: string; state: string }
  | { kind: "error"; message: string };

export function canUseLoopback(): boolean {
  return getIsElectron();
}

export function runLoopback(input: {
  authorizeUrl: string;
  redirectUri: string;
}): Promise<LoopbackResult> {
  return invokeDesktopCommand<LoopbackResult>("jira_oauth_loopback", input);
}

export type OAuthOutcome =
  | { kind: "connected"; connection: JiraConnection }
  | { kind: "choose_site"; state: string; sites: JiraOAuthSite[] };

export async function completeOAuth(
  call: JiraCall,
  input: { state: string; code?: string; callbackUrl?: string; cloudId?: string },
): Promise<OAuthOutcome> {
  const result = await call("jira.oauth.complete.request", input);
  if (result.connection) return { kind: "connected", connection: result.connection };
  return { kind: "choose_site", state: input.state, sites: result.sites ?? [] };
}

/** Desktop: begin is already done; run the loopback and hand the code to the daemon. */
export async function finishWithLoopback(
  call: JiraCall,
  begun: { state: string; authorizeUrl: string; redirectUri: string },
): Promise<OAuthOutcome> {
  const result = await runLoopback(begun);
  if (result.kind === "error") throw new Error(result.message);
  if (result.state !== begun.state)
    throw new Error("The browser returned a different sign-in. Start again.");
  return completeOAuth(call, { state: begun.state, code: result.code });
}
