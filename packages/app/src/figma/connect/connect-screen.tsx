import {
  default as React,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { commitFigmaConnection, removeFigmaConnection } from "./connection-cache";
import type { FigmaConnection } from "@jagentdesk/protocol/figma/rpc-schemas";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { callFigma, useFigmaCall } from "@/figma/api";
import {
  AuthDot,
  CopyButton,
  ErrorBanner,
  Field,
  Input,
  SectionHeading,
  type AuthDotTone,
} from "@/figma/ui/primitives";
import { figmaStyles } from "@/figma/ui/styles";
import { Button } from "@/components/ui/button";
import { openExternalUrl } from "@/utils/open-external-url";
import {
  canUseLoopback,
  finishWithLoopback,
  FIGMA_APPS_URL,
  FIGMA_CALLBACK_URL,
  FIGMA_OAUTH_SCOPES,
} from "./oauth-flow";
import {
  configureFigmaConnect,
  cancelFigmaBrowserSignIn,
  getFigmaConnectState,
  requestFigmaDelegatedSignIn,
  resetFigmaConnect,
  setFigmaConnectDraft,
  startFigmaBrowserSignIn,
  startFigmaPasteSignIn,
  submitFigmaPastedUrl,
  subscribeFigmaConnect,
} from "./store";

// The connect surface (spec 32.2): a step-by-step guide to create a private Figma OAuth app,
// copyable callback URL and scope list, client ID + secret fields, and the three sign-in paths —
// desktop loopback, paste the final URL, or ask a paired desktop (mobile).

function useConnectState(serverId: string) {
  return useSyncExternalStore(subscribeFigmaConnect, () => getFigmaConnectState(serverId));
}

function GuideStep({ index, children }: { index: number; children: ReactNode }) {
  return (
    <View style={figmaStyles.row}>
      <Text style={figmaStyles.label}>{`${index}.`}</Text>
      <View style={figmaStyles.flex1}>{children}</View>
    </View>
  );
}

function dotTone(authState: FigmaConnection["authState"]): AuthDotTone {
  if (authState === "connected") return "ok";
  if (authState === "needs_reauth") return "needs-auth";
  return "expired";
}

function delegationHint(outcome: "sent" | "no-desktop" | "missing" | "error"): string {
  if (outcome === "sent") return "Check your desktop — it will open the Figma sign-in page.";
  if (outcome === "no-desktop")
    return "No paired desktop is online. Sign in there first, or paste the URL here.";
  if (outcome === "missing") return "Enter the Client ID and Client Secret first.";
  return "The desktop could not start the sign-in.";
}

function ConnectedRow({ serverId, connection }: { serverId: string; connection: FigmaConnection }) {
  const call = useFigmaCall(serverId);
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const tone = dotTone(connection.authState);
  const test = useCallback(async () => {
    setBusy(true);
    try {
      // `figma.connections.test` is GET /v1/me: it proves the account sign-in, never file access
      // (the live 403 came after a 200 /me). Say exactly what was checked.
      await commitFigmaConnection(queryClient, serverId, () =>
        call("figma.connections.test.request", { connectionId: connection.id }),
      );
      setNote("Account sign-in is valid. File access is checked when a file is added.");
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [call, connection.id, queryClient, serverId]);
  const remove = useCallback(async () => {
    setBusy(true);
    try {
      await removeFigmaConnection(queryClient, serverId, connection.id, () =>
        call("figma.connections.remove.request", { connectionId: connection.id }),
      );
      setNote(null);
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [call, connection.id, queryClient, serverId]);
  return (
    <View style={figmaStyles.row} testID={`figma-connection-row-${connection.id}`}>
      <AuthDot tone={tone} />
      <View style={figmaStyles.flex1}>
        <Text style={figmaStyles.rowTitle}>{connection.account.handle}</Text>
        <Text style={figmaStyles.rowSubtle}>
          {connection.account.email ?? connection.id}
          {connection.authState === "needs_reauth" ? " · needs re-auth" : ""}
        </Text>
        {note ? <Text style={figmaStyles.rowSubtle}>{note}</Text> : null}
      </View>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onPress={test}
        testID="figma-connection-test"
      >
        Test
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onPress={remove}
        testID="figma-connection-remove"
      >
        Remove
      </Button>
    </View>
  );
}

export function FigmaConnectScreen({
  serverId,
  connections,
  onConnected,
}: {
  serverId: string;
  connections: FigmaConnection[];
  onConnected?: () => void;
}) {
  const client = useHostRuntimeClient(serverId);
  const queryClient = useQueryClient();
  const [addingAccount, setAddingAccount] = useState(false);
  const showSetup = connections.length === 0 || addingAccount;
  const toggleAddAccount = useCallback(() => setAddingAccount((value) => !value), []);
  const state = useConnectState(serverId);
  const [pastedUrl, setPastedUrl] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const loopback = canUseLoopback();

  // The store talks to the daemon through these ops; configured while this screen is mounted.
  useEffect(() => {
    const complete: Parameters<typeof finishWithLoopback>[0] = (params) =>
      commitFigmaConnection(queryClient, serverId, () =>
        callFigma(client, "figma.oauth.complete.request", {
          attemptId: params.attemptId,
          ...(params.code ? { code: params.code } : {}),
          ...(params.state ? { state: params.state } : {}),
          ...(params.pastedUrl ? { pastedUrl: params.pastedUrl } : {}),
        }),
      );
    configureFigmaConnect({
      begin: (input) => callFigma(client, "figma.oauth.begin.request", input),
      complete: async (input) => {
        const response = await complete(input);
        return { connected: response.connection !== null };
      },
      runLoopback: (begin, wait) => finishWithLoopback(complete, begin, wait),
      delegate: (input) => callFigma(client, "figma.oauth.delegate.request", input),
    });
    return () => configureFigmaConnect(null);
  }, [client, queryClient, serverId]);

  useEffect(() => {
    // Consume the completion before navigating. The route may render this guide again while
    // its connection query catches up, and each navigation creates a new callback. Read the
    // current store so StrictMode cannot replay a completion from an older snapshot either.
    if (onConnected && getFigmaConnectState(serverId).signedInLabel) {
      resetFigmaConnect(serverId);
      onConnected();
    }
  }, [serverId, state.signedInLabel, onConnected]);

  const busy =
    state.phase.kind === "starting" ||
    state.phase.kind === "waiting-browser" ||
    state.phase.kind === "finishing";
  const errorMessageText = state.phase.kind === "error" ? state.phase.message : null;
  const scopesText = useMemo(() => FIGMA_OAUTH_SCOPES.join(", "), []);

  const openApps = useCallback(() => {
    void openExternalUrl(FIGMA_APPS_URL);
  }, []);
  const openAuthorize = useCallback(() => {
    if (state.phase.kind === "browser-opened") void openExternalUrl(state.phase.authorizeUrl);
  }, [state.phase]);
  const changeClientId = useCallback(
    (text: string) => setFigmaConnectDraft(serverId, { clientId: text }),
    [serverId],
  );
  const changeClientSecret = useCallback(
    (text: string) => setFigmaConnectDraft(serverId, { clientSecret: text }),
    [serverId],
  );
  const dismiss = useCallback(() => resetFigmaConnect(serverId), [serverId]);
  const cancelSignIn = useCallback(() => cancelFigmaBrowserSignIn(serverId), [serverId]);
  const signInWithBrowser = useCallback(() => {
    void startFigmaBrowserSignIn(serverId);
  }, [serverId]);
  const signInWithPaste = useCallback(() => {
    void startFigmaPasteSignIn(serverId);
  }, [serverId]);
  const onDelegate = useCallback(() => {
    void requestFigmaDelegatedSignIn(serverId).then((outcome) => {
      setNote(delegationHint(outcome));
      return true;
    });
  }, [serverId]);
  const submitPasted = useCallback(() => {
    void submitFigmaPastedUrl(serverId, pastedUrl);
  }, [pastedUrl, serverId]);
  const dismissAction = useMemo(
    () => (
      <Button size="sm" variant="ghost" onPress={dismiss}>
        Dismiss
      </Button>
    ),
    [dismiss],
  );

  return (
    <ScrollView style={figmaStyles.screen} contentContainerStyle={figmaStyles.scrollContent}>
      <View style={figmaStyles.stack} testID="figma-connect-screen">
        {connections.length > 0 ? (
          <View style={figmaStyles.card} testID="figma-connected-connections">
            <SectionHeading title="Connected" />
            {connections.map((connection) => (
              <ConnectedRow key={connection.id} serverId={serverId} connection={connection} />
            ))}
          </View>
        ) : null}

        {connections.length > 0 ? (
          <Button variant="outline" size="sm" onPress={toggleAddAccount} testID="figma-add-account">
            {addingAccount ? "Cancel" : "Add account"}
          </Button>
        ) : null}
        {showSetup ? (
          <>
            <Text style={figmaStyles.headerTitle}>Connect Figma</Text>
            <Text style={figmaStyles.sectionHint}>
              JAgentDesk signs in with a private OAuth app you register once in the Figma developer
              console. Your dev machine keeps the token.
            </Text>

            <View style={figmaStyles.guide} testID="figma-connect-guide">
              <GuideStep index={1}>
                <Text style={figmaStyles.guideBody}>
                  Open{" "}
                  <Text style={figmaStyles.guideLink} onPress={openApps}>
                    www.figma.com/developers/apps
                  </Text>{" "}
                  and create a private OAuth application.
                </Text>
              </GuideStep>
              <GuideStep index={2}>
                <Text style={figmaStyles.guideBody}>Set the redirect URI to exactly</Text>
                <View style={figmaStyles.row}>
                  <Text style={figmaStyles.mono}>{FIGMA_CALLBACK_URL}</Text>
                  <CopyButton
                    value={FIGMA_CALLBACK_URL}
                    label="Copy"
                    testID="figma-copy-callback"
                  />
                </View>
              </GuideStep>
              <GuideStep index={3}>
                <Text style={figmaStyles.guideBody}>Enable these scopes</Text>
                <View style={figmaStyles.row}>
                  <Text style={figmaStyles.mono} testID="figma-guide-scopes">
                    {scopesText}
                  </Text>
                  <CopyButton value={scopesText} label="Copy all" testID="figma-copy-scopes" />
                </View>
              </GuideStep>
              <GuideStep index={4}>
                <Text style={figmaStyles.guideBody}>
                  Copy the Client ID and Client Secret into the fields below, then start the
                  sign-in.
                </Text>
              </GuideStep>
            </View>

            <Field label="Client ID">
              <Input
                value={state.clientId}
                onChangeText={changeClientId}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel="Client ID"
                testID="figma-client-id"
              />
            </Field>
            <Field label="Client secret">
              <Input
                value={state.clientSecret}
                onChangeText={changeClientSecret}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel="Client secret"
                testID="figma-client-secret"
              />
            </Field>

            {errorMessageText ? (
              <ErrorBanner message={errorMessageText} action={dismissAction} />
            ) : null}

            <View style={figmaStyles.row}>
              {loopback ? (
                <Button
                  variant="default"
                  loading={busy}
                  disabled={busy}
                  onPress={signInWithBrowser}
                  testID="figma-signin-browser"
                >
                  Sign in with browser
                </Button>
              ) : null}
              <Button
                variant={loopback ? "outline" : "default"}
                loading={busy && !loopback}
                disabled={busy}
                onPress={signInWithPaste}
                testID="figma-signin-paste"
              >
                Paste a URL instead
              </Button>
              {!loopback ? (
                <Button
                  variant="outline"
                  disabled={busy}
                  onPress={onDelegate}
                  testID="figma-signin-delegate"
                >
                  Sign in on a desktop
                </Button>
              ) : null}
            </View>
            {state.phase.kind === "waiting-browser" ? (
              <Button variant="ghost" onPress={cancelSignIn} testID="figma-signin-cancel">
                Cancel sign-in
              </Button>
            ) : null}
            {note ? <Text style={figmaStyles.rowSubtle}>{note}</Text> : null}

            {state.phase.kind === "browser-opened" ? (
              <View style={figmaStyles.card} testID="figma-paste-panel">
                <SectionHeading
                  title="Finish in your browser"
                  hint="Open the sign-in page, approve access, then copy the address the browser lands on — http://127.0.0.1:8766/figma/callback?code=… — into the field."
                />
                <Pressable
                  style={figmaStyles.pressableRow}
                  onPress={openAuthorize}
                  accessibilityRole="button"
                  testID="figma-open-authorize"
                >
                  <Text style={figmaStyles.rowTitle}>Open the Figma sign-in page</Text>
                </Pressable>
                <Field label="Pasted URL">
                  <Input
                    value={pastedUrl}
                    onChangeText={setPastedUrl}
                    placeholder="http://127.0.0.1:8766/figma/callback?code=…&state=…"
                    autoCapitalize="none"
                    autoCorrect={false}
                    testID="figma-pasted-url"
                  />
                </Field>
                <Button
                  variant="default"
                  disabled={!pastedUrl.trim() || busy}
                  loading={busy}
                  onPress={submitPasted}
                  testID="figma-paste-submit"
                >
                  Complete sign-in
                </Button>
              </View>
            ) : null}
          </>
        ) : null}
      </View>
    </ScrollView>
  );
}
