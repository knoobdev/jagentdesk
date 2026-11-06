import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { commitFigmaConnection } from "./connection-cache";
import type { FigmaOAuthDelegation } from "@jagentdesk/protocol/figma/rpc-schemas";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { confirmDialog } from "@/utils/confirm-dialog";
import { callFigma } from "@/figma/api";
import { beginFigmaOAuthLoopback, canUseLoopback } from "./oauth-flow";

// Desktop half of "Sign in on a desktop" (spec 32.2): when a phone asks the daemon to sign in to
// Figma, every paired desktop app on that host offers to run the browser step. The push carries
// the attempt the daemon opened for the phone, so completing that attemptId answers it. Renders
// nothing.

async function runDelegatedSignIn(
  client: DaemonClient,
  message: FigmaOAuthDelegation,
  queryClient: QueryClient,
  serverId: string,
): Promise<void> {
  const accepted = await confirmDialog({
    title: "Sign in to Figma for another device",
    message:
      "A paired device asked this desktop to open the Figma sign-in page. Continue in your browser?",
    confirmLabel: "Open browser",
  });
  if (!accepted) return;
  const result = await beginFigmaOAuthLoopback({
    authorizeUrl: message.authorizeUrl,
    redirectUri: message.redirectUri,
  });
  if (result.kind === "error") return;
  await commitFigmaConnection(queryClient, serverId, () =>
    callFigma(client, "figma.oauth.complete.request", {
      attemptId: message.attemptId,
      code: result.code,
      state: result.state,
    }),
  ).catch(() => undefined);
}

export function FigmaOAuthDelegationBinder({ serverId }: { serverId: string }): null {
  const client = useHostRuntimeClient(serverId);
  const queryClient = useQueryClient();
  const supportsFigma = useHostFeature(serverId, "figma");
  useEffect(() => {
    if (!client || !supportsFigma || !canUseLoopback()) return;
    return client.onFigmaPush("figma.oauth.delegation", (message) => {
      void runDelegatedSignIn(client, message, queryClient, serverId);
    });
  }, [client, supportsFigma, queryClient, serverId]);
  return null;
}
