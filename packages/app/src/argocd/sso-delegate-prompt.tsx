import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { getDesktopSsoBridge, runDesktopSso } from "./sso";
import { errorMessage } from "./use-instances";

// Desktop side of "Sign in with SSO on a desktop" (spec 30.2.2): the daemon forwards a paired
// device's request to desktops with the SSO loopback capability; the user approves it here
// and the desktop runs the browser flow of 30.2.1. Renders nothing outside Electron.

interface DelegateRequest {
  instanceId: string;
  displayName: string;
  url: string;
}

type PromptState =
  | { status: "asking" }
  | { status: "running" }
  | { status: "done" }
  | { status: "failed"; message: string };

export function ArgoCdSsoDelegatePrompt({ serverId }: { serverId: string }) {
  const client = useHostRuntimeClient(serverId);
  const bridge = getDesktopSsoBridge();
  const [request, setRequest] = useState<DelegateRequest | null>(null);
  const [prompt, setPrompt] = useState<PromptState>({ status: "asking" });

  useEffect(() => {
    if (!client || !bridge) return;
    return client.on("argocd.sso.delegate_requested", (message) => {
      setRequest(message.payload);
      setPrompt({ status: "asking" });
    });
  }, [bridge, client]);

  const close = useCallback(() => setRequest(null), []);
  const approve = useCallback(async () => {
    if (!client || !bridge || !request) return;
    setPrompt({ status: "running" });
    try {
      const outcome = await runDesktopSso(client, bridge, request.instanceId);
      setPrompt(outcome.ok ? { status: "done" } : { status: "failed", message: outcome.message });
    } catch (error) {
      setPrompt({ status: "failed", message: errorMessage(error, "Unable to sign in with SSO") });
    }
  }, [bridge, client, request]);
  const handleApprove = useCallback(() => {
    void approve();
  }, [approve]);

  const running = prompt.status === "running";
  const header = useMemo(() => ({ title: "Argo CD sign-in request" }), []);
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        {prompt.status === "done" ? (
          <Button size="md" variant="default" onPress={close} testID="argocd-delegate-done">
            Done
          </Button>
        ) : (
          <>
            <Button size="md" variant="ghost" onPress={close} disabled={running}>
              Dismiss
            </Button>
            <Button
              size="md"
              variant="default"
              loading={running}
              disabled={running}
              onPress={handleApprove}
              testID="argocd-delegate-approve"
            >
              {running ? "Waiting for the browser..." : "Approve"}
            </Button>
          </>
        )}
      </View>
    ),
    [close, handleApprove, prompt.status, running],
  );

  if (!request || !bridge) return null;
  return (
    <AdaptiveModalSheet
      visible
      onClose={close}
      onDismiss={close}
      header={header}
      footer={footer}
      desktopMaxWidth={480}
      testID="argocd-delegate-prompt"
    >
      <View style={styles.body}>
        <Text style={styles.text}>
          {`A paired device asked to sign in to ${request.displayName} (${request.url}) with SSO.`}
        </Text>
        {prompt.status === "running" ? (
          <Text style={styles.hint}>Finish signing in in your browser</Text>
        ) : null}
        {prompt.status === "done" ? (
          <Text style={styles.success}>{`Signed in to ${request.displayName}`}</Text>
        ) : null}
        {prompt.status === "failed" ? <Text style={styles.error}>{prompt.message}</Text> : null}
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  text: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  hint: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  success: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.statusSuccess,
  },
  error: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.statusDanger,
  },
  footer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
