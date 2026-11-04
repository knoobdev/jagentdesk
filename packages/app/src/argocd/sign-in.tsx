import { useCallback, useReducer, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { ArgoCdInstance } from "@jagentdesk/protocol/argocd/rpc-schemas";
import type { DesktopArgoCdBridge } from "@/desktop/host";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { getDesktopSsoBridge, runDesktopSso } from "./sso";
import { errorMessage } from "./use-instances";

// Sign in to one instance (spec 30.2): password, API token, or SSO — in the system browser on
// desktop, delegated to a paired desktop on mobile (30.2.2).

type SignInState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "waiting_browser" }
  | { status: "waiting_desktop" }
  | { status: "failed"; message: string };

type SignInAction =
  | { type: "start"; next: "pending" | "waiting_browser" }
  | { type: "delegated" }
  | { type: "failed"; message: string }
  | { type: "done" };

function reduce(_state: SignInState, action: SignInAction): SignInState {
  switch (action.type) {
    case "start":
      return { status: action.next };
    case "delegated":
      return { status: "waiting_desktop" };
    case "failed":
      return { status: "failed", message: action.message };
    case "done":
      return { status: "idle" };
  }
}

const NO_DESKTOP = "No desktop is online — sign in with a password or an API token";

interface SignInProps {
  client: DaemonClient;
  instance: ArgoCdInstance;
  onInstance: (instance: ArgoCdInstance) => void;
}

/** Shared pending / failure state; `finish` applies a sign-in response. */
function useSignInFlow(onInstance: (instance: ArgoCdInstance) => void) {
  const [state, dispatch] = useReducer(reduce, { status: "idle" });
  const finish = useCallback(
    (next: ArgoCdInstance | null, error: string | null): boolean => {
      if (next) onInstance(next);
      if (error) {
        dispatch({ type: "failed", message: error });
        return false;
      }
      if (next && next.state !== "connected") {
        dispatch({ type: "failed", message: next.lastError ?? "Sign-in did not complete" });
        return false;
      }
      dispatch({ type: "done" });
      return true;
    },
    [onInstance],
  );
  return { state, dispatch, finish };
}

function Failure({ state }: { state: SignInState }) {
  if (state.status !== "failed") return null;
  return (
    <Text style={styles.error} testID="argocd-signin-error">
      {state.message}
    </Text>
  );
}

export function ArgoCdSignIn({ client, instance, onInstance }: SignInProps) {
  const bridge = getDesktopSsoBridge();
  if (instance.authMethod === "sso") {
    return bridge ? (
      <DesktopSsoSignIn
        client={client}
        instance={instance}
        onInstance={onInstance}
        bridge={bridge}
      />
    ) : (
      <DelegateSsoSignIn client={client} instance={instance} onInstance={onInstance} />
    );
  }
  if (instance.authMethod === "password" && instance.userLoginsDisabled) {
    return (
      <Text style={styles.hint}>
        Local users are disabled on this Argo CD. Edit the instance to sign in with SSO or an API
        token.
      </Text>
    );
  }
  return <SecretSignIn client={client} instance={instance} onInstance={onInstance} />;
}

function DesktopSsoSignIn({
  client,
  instance,
  onInstance,
  bridge,
}: SignInProps & { bridge: DesktopArgoCdBridge }) {
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const { state, dispatch, finish } = useSignInFlow(onInstance);
  const waiting = state.status === "waiting_browser";

  const signIn = useCallback(async () => {
    dispatch({ type: "start", next: "waiting_browser" });
    try {
      const outcome = await runDesktopSso(client, bridge, instance.id);
      if (outcome.ok) finish(outcome.instance, null);
      else dispatch({ type: "failed", message: outcome.message });
    } catch (error) {
      dispatch({ type: "failed", message: errorMessage(error, "Unable to sign in with SSO") });
    }
  }, [bridge, client, dispatch, finish, instance.id]);
  const handlePress = useCallback(() => {
    void signIn();
  }, [signIn]);

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        <Button
          size={size}
          variant="outline"
          loading={waiting}
          disabled={waiting}
          onPress={handlePress}
          testID="argocd-signin-sso"
        >
          {waiting ? "Waiting for the browser..." : "Sign in with SSO"}
        </Button>
      </View>
      {waiting ? <Text style={styles.hint}>Finish signing in in your browser</Text> : null}
      <Failure state={state} />
    </View>
  );
}

function DelegateSsoSignIn({ client, instance, onInstance }: SignInProps) {
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const { state, dispatch } = useSignInFlow(onInstance);
  const pending = state.status === "pending";

  const delegate = useCallback(async () => {
    dispatch({ type: "start", next: "pending" });
    try {
      const res = await client.argocd("argocd.sso.delegate.request", { id: instance.id });
      if (res.errorCode === "sso_no_desktop") dispatch({ type: "failed", message: NO_DESKTOP });
      else if (res.error) dispatch({ type: "failed", message: res.error });
      else dispatch({ type: "delegated" });
    } catch (error) {
      dispatch({ type: "failed", message: errorMessage(error, "Unable to reach a desktop") });
    }
  }, [client, dispatch, instance.id]);
  const handlePress = useCallback(() => {
    void delegate();
  }, [delegate]);

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        <Button
          size={size}
          variant="outline"
          loading={pending}
          disabled={pending}
          onPress={handlePress}
          testID="argocd-signin-sso-delegate"
        >
          Sign in with SSO on a desktop
        </Button>
      </View>
      {state.status === "waiting_desktop" ? (
        <Text style={styles.hint} testID="argocd-signin-waiting-desktop">
          Approve the sign-in on your desktop
        </Text>
      ) : null}
      <Failure state={state} />
    </View>
  );
}

function SecretSignIn({ client, instance, onInstance }: SignInProps) {
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const { state, dispatch, finish } = useSignInFlow(onInstance);
  const [secret, setSecret] = useState("");
  const [resetKey, setResetKey] = useState(0);
  const busy = state.status === "pending";
  const isToken = instance.authMethod === "token";

  const signIn = useCallback(async () => {
    dispatch({ type: "start", next: "pending" });
    const params = isToken
      ? { id: instance.id, token: secret.trim() }
      : { id: instance.id, password: secret ? secret : undefined };
    try {
      const res = await client.argocd("argocd.instances.login.request", params);
      if (finish(res.instance, res.error)) {
        setSecret("");
        setResetKey((key) => key + 1);
      }
    } catch (error) {
      dispatch({ type: "failed", message: errorMessage(error, "Unable to sign in") });
    }
  }, [client, dispatch, finish, instance.id, isToken, secret]);
  const handleSubmit = useCallback(() => {
    void signIn();
  }, [signIn]);

  let placeholder = isToken ? "API token" : "Password";
  if (!isToken && instance.rememberPassword) placeholder = "Saved password";
  const hasSecret = isToken ? secret.trim().length > 0 : secret.length > 0;
  const canSubmit = hasSecret || (!isToken && instance.rememberPassword);
  return (
    <View style={styles.container}>
      {!isToken && instance.username ? (
        <Text style={styles.hint}>{`Sign in as ${instance.username}`}</Text>
      ) : null}
      <View style={styles.row}>
        <View style={styles.input}>
          <FormTextInput
            size={size}
            resetKey={resetKey}
            initialValue=""
            onChangeText={setSecret}
            onSubmitEditing={canSubmit ? handleSubmit : undefined}
            placeholder={placeholder}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
            testID="argocd-signin-secret"
          />
        </View>
        <Button
          size={size}
          variant="outline"
          loading={busy}
          disabled={busy || !canSubmit}
          onPress={handleSubmit}
          testID="argocd-signin-submit"
        >
          {busy ? "Signing in..." : "Sign in"}
        </Button>
      </View>
      <Failure state={state} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[2],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  input: {
    flexGrow: 1,
    flexBasis: 220,
    maxWidth: 360,
  },
  hint: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  error: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.statusDanger,
  },
}));
