import { useEffect } from "react";
import type { JiraOAuthDelegation } from "@jagentdesk/protocol/jira/rpc-schemas";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { confirmDialog } from "@/utils/confirm-dialog";
import { callJira } from "../api";
import { canUseLoopback, runLoopback } from "./oauth-flow";

// Desktop half of "Sign in on a desktop" (spec 29.1.1 step 4): when a phone asks the daemon to
// sign in to Jira, every paired desktop app on that host offers to run the browser step. The
// first one to finish wins; the daemon then tells the phone (jira.oauth.progress). Renders nothing.

async function runDelegatedSignIn(
  client: DaemonClient,
  message: JiraOAuthDelegation,
): Promise<void> {
  const accepted = await confirmDialog({
    title: "Sign in to Jira for another device",
    message:
      "A paired device asked this desktop to open the Jira sign-in page. Continue in your browser?",
    confirmLabel: "Open browser",
  });
  if (!accepted) return;
  const result = await runLoopback(message);
  if (result.kind === "error" || result.state !== message.state) return;
  // A failure here reaches the requesting device as jira.oauth.progress "failed".
  await callJira(client, "jira.oauth.complete.request", {
    state: message.state,
    code: result.code,
  }).catch(() => undefined);
}

export function JiraOAuthDelegationBinder({ serverId }: { serverId: string }): null {
  const client = useHostRuntimeClient(serverId);
  const supportsJira = useHostFeature(serverId, "jira");
  useEffect(() => {
    if (!client || !supportsJira || !canUseLoopback()) return;
    return client.onJiraPush("jira.oauth.delegation", (message) => {
      void runDelegatedSignIn(client, message);
    });
  }, [client, supportsJira]);
  return null;
}
