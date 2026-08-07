import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, TextInput, View } from "react-native";
import type { TextInput as TextInputType } from "react-native";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyRound } from "lucide-react-native";
import Svg, { Circle, Path } from "react-native-svg";
import * as WebBrowser from "expo-web-browser";
import { Button } from "@/components/ui/button";
import { JAgentDeskLogo } from "@/components/icons/jagentdesk-logo";
import { isNative } from "@/constants/platform";
import { SPACING } from "@/styles/theme";
import {
  getSnapshot,
  getTailscaleLoginAdapter,
  refreshTailscaleStatus,
  setConnectionMode,
} from "@/tailscale";
import type { TailscaleLoginAdapter } from "@/tailscale";

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  scrollView: {
    flex: 1,
  },
  container: {
    flexGrow: 1,
    padding: theme.spacing[6],
    paddingBottom: 0,
    alignItems: "center",
  },
  content: {
    width: "100%",
    maxWidth: 420,
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  copyBlock: {
    alignItems: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[6],
    marginBottom: theme.spacing[8],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.medium,
    textAlign: "center",
  },
  subtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  card: {
    width: "100%",
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.xl,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing[6],
    gap: theme.spacing[3],
  },
  divider: {
    height: 1,
    backgroundColor: theme.colors.border,
    marginVertical: theme.spacing[2],
  },
  fieldLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  input: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  placeholderColor: {
    color: theme.colors.foregroundExtraMuted,
  },
  connectingText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  connectionTypeRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
    marginTop: theme.spacing[4],
  },
  note: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textAlign: "center",
    marginTop: theme.spacing[6],
  },
}));

const AUTH_KEY_STATUS_TIMEOUT_MS = 10_000;
const AUTH_KEY_STATUS_POLL_MS = 250;
const AUTH_KEY_STATUS_PROBE_TIMEOUT_MS = 2_000;
const INTERACTIVE_LOGIN_TIMEOUT_MS = 120_000;
const INTERACTIVE_LOGIN_URL_POLL_MS = 250;

async function refreshTailscaleStatusBounded(): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      refreshTailscaleStatus(),
      new Promise<void>((resolve) => {
        timeoutId = setTimeout(resolve, AUTH_KEY_STATUS_PROBE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

async function waitForTailscaleConnection(
  isActive: () => boolean,
  timeoutMs = AUTH_KEY_STATUS_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isActive()) {
    await refreshTailscaleStatusBounded();
    if (!isActive()) {
      return false;
    }
    if (getSnapshot().kind === "connected") {
      return true;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return false;
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(AUTH_KEY_STATUS_POLL_MS, remainingMs)),
    );
  }
  return false;
}

async function waitForInteractiveLoginUrl(
  adapter: TailscaleLoginAdapter,
  isActive: () => boolean,
): Promise<string | null> {
  const deadline = Date.now() + INTERACTIVE_LOGIN_TIMEOUT_MS;
  while (isActive() && Date.now() < deadline) {
    const authUrl = adapter.getInteractiveLoginUrl?.() ?? null;
    if (authUrl?.startsWith("https://")) {
      return authUrl;
    }
    const remainingMs = deadline - Date.now();
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(INTERACTIVE_LOGIN_URL_POLL_MS, Math.max(0, remainingMs))),
    );
  }
  return null;
}

function TailscaleMark() {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24" accessibilityLabel="Tailscale">
      <Circle cx="12" cy="12" r="11" fill="#4C8DFF" />
      <Path
        d="M6.2 14.9 9.5 8h2.1l-1.2 3h3.2l-1.1 3h-2l-1.2 3H7.2l1.2-3H6.2Zm8.1 0 1.8-3h2.1l-1.8 3h1.4l-1.8 3h-2.1l1.8-3h-1.4Z"
        fill="white"
      />
    </Svg>
  );
}

export default function TailscaleLoginRoute() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{ returnTo?: string }>();
  const returnTo = params.returnTo === "pair-verify" ? "/pair-verify" : "/";
  const adapter = useMemo<TailscaleLoginAdapter>(() => getTailscaleLoginAdapter(), []);
  const isDesktopLogin = adapter.platform === "desktop";
  const authKeyInputRef = useRef<TextInputType | null>(null);
  const authKeySubmitInFlightRef = useRef(false);
  const authKeyErrorVisibleRef = useRef(false);
  const statusCheckInFlightRef = useRef(false);
  const mountedRef = useRef(true);

  const [interactiveInProgress, setInteractiveInProgress] = useState(false);
  const [authKeyInProgress, setAuthKeyInProgress] = useState(false);
  const [authKey, setAuthKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [connectionType, setConnectionType] = useState<"tailscale" | "local">("tailscale");

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const clearAuthKey = useCallback(() => {
    setAuthKey("");
    authKeyInputRef.current?.clear();
  }, []);

  const handleInteractiveLogin = useCallback(async () => {
    authKeyErrorVisibleRef.current = false;
    setError(null);
    setInteractiveInProgress(true);
    try {
      // Native tsnet produces the control-plane URL asynchronously. Open it
      // in Expo's in-app browser so the app owns the browser session and can
      // dismiss it as soon as the node reports a completed login.
      if (!isDesktopLogin && adapter.getInteractiveLoginUrl) {
        const preparation = adapter.prepareInteractiveLogin?.() ?? { ok: true };
        if (!preparation.ok) {
          setError(preparation.error ?? t("tailscaleLogin.errorFailed"));
          return;
        }
        const authUrl = await waitForInteractiveLoginUrl(adapter, () => mountedRef.current);
        if (!authUrl || !mountedRef.current) {
          setError("Tailscale did not provide a login URL. Try again.");
          return;
        }

        let browserClosed = false;
        const browserPromise = WebBrowser.openBrowserAsync(authUrl)
          .catch(() => null)
          .then((result) => {
            browserClosed = true;
            return result;
          });
        const connected = await Promise.race([
          waitForTailscaleConnection(
            () => mountedRef.current && !browserClosed,
            INTERACTIVE_LOGIN_TIMEOUT_MS,
          ),
          browserPromise.then(() => false),
        ]);

        if (!mountedRef.current) {
          return;
        }

        if (connected) {
          await WebBrowser.dismissBrowser().catch(() => undefined);
          await browserPromise;
          await setConnectionMode("tailscale");
          router.replace(returnTo as Href);
          return;
        }

        // The user may have closed the browser immediately after completing
        // login. Perform one final real status refresh before showing an error.
        await browserPromise;
        await refreshTailscaleStatusBounded();
        if (getSnapshot().kind === "connected") {
          await setConnectionMode("tailscale");
          router.replace(returnTo as Href);
          return;
        }
        setError("Tailscale login was not completed. Open Sign in with Tailscale to try again.");
        return;
      }

      const result = await adapter.startInteractiveLogin();
      if (result.ok) {
        // The adapter opens the real control-plane URL/app. Re-check once
        // immediately so an already-completed login transitions now; the
        // background monitor continues polling while the user finishes the
        // browser login.
        await refreshTailscaleStatusBounded();
        if (!mountedRef.current) {
          return;
        }
        if (getSnapshot().kind === "connected") {
          await setConnectionMode("tailscale");
          router.replace(returnTo as Href);
          return;
        }
        setError("Tailscale login opened. Finish it; this screen will reconnect automatically.");
      } else {
        setError(result.error ?? t("tailscaleLogin.errorFailed"));
      }
    } catch {
      setError(t("tailscaleLogin.errorFailed"));
    } finally {
      setInteractiveInProgress(false);
    }
  }, [adapter, isDesktopLogin, returnTo, router, t]);

  const handleCheckStatus = useCallback(async () => {
    if (
      statusCheckInFlightRef.current ||
      interactiveInProgress ||
      authKeyInProgress ||
      authKeyErrorVisibleRef.current
    ) {
      return;
    }
    statusCheckInFlightRef.current = true;
    setError(null);
    try {
      await refreshTailscaleStatus();
      const status = getSnapshot();
      if (status.kind === "connected") {
        await setConnectionMode("tailscale");
        router.replace(returnTo as Href);
      } else if (status.kind === "unavailable") {
        // Not being authenticated is the expected initial state. Do not show
        // it as a connectivity failure before the user has joined a tailnet.
        setError("Tailscale is unavailable on this device. Install Tailscale or use an auth key.");
      } else {
        setError(null);
      }
    } catch {
      // A status probe can fail while the native node is still starting. The
      // login screen is itself the recovery path, so keep it actionable and
      // avoid claiming that the computer is unreachable before authentication.
      setError(null);
    } finally {
      statusCheckInFlightRef.current = false;
    }
  }, [authKeyInProgress, interactiveInProgress, returnTo, router]);

  useEffect(() => {
    // Do not race the interactive login with the background status probe. The
    // native login path needs to start tsnet and obtain its auth URL; probing
    // concurrently can observe the half-started node and replace the useful
    // login result with a generic connectivity error.
    if (interactiveInProgress || authKeyInProgress) {
      return;
    }
    void handleCheckStatus();
    const timer = setInterval(() => void handleCheckStatus(), 10000);
    return () => clearInterval(timer);
  }, [authKeyInProgress, handleCheckStatus, interactiveInProgress]);

  const handleAuthKeySubmit = useCallback(async () => {
    if (authKeySubmitInFlightRef.current) {
      return;
    }
    const key = authKey.trim();
    if (!key) {
      setError(t("tailscaleLogin.errorRequired"));
      return;
    }
    // The key is a secret: drop it from the input before awaiting so it never
    // lingers, then pass it straight to the adapter, which never logs it.
    authKeySubmitInFlightRef.current = true;
    authKeyErrorVisibleRef.current = false;
    setError(null);
    setAuthKeyInProgress(true);
    clearAuthKey();
    try {
      const result = await adapter.loginWithAuthKey(key);
      if (result.ok) {
        // The native join call and the JS status store are separate state
        // machines. Refresh before navigating, otherwise pair-verify sees the
        // stale `needs-login` snapshot and immediately sends the user back to
        // this screen, which looks like a form that flashes and disappears.
        const connected = await waitForTailscaleConnection(() => mountedRef.current);
        if (!mountedRef.current) {
          return;
        }
        if (!connected) {
          authKeyErrorVisibleRef.current = true;
          setError("Tailscale joined, but the connection is not ready yet. Try again.");
          return;
        }
        await setConnectionMode("tailscale");
        router.replace(returnTo as Href);
      } else {
        authKeyErrorVisibleRef.current = true;
        setError(result.error ?? t("tailscaleLogin.errorFailed"));
      }
    } catch {
      authKeyErrorVisibleRef.current = true;
      setError(t("tailscaleLogin.errorFailed"));
    } finally {
      setAuthKeyInProgress(false);
      authKeySubmitInFlightRef.current = false;
    }
  }, [adapter, authKey, clearAuthKey, returnTo, router, t]);

  const busy = interactiveInProgress || authKeyInProgress;
  const showLocalFallback = !adapter.isSupported && !isDesktopLogin;

  return (
    <View style={styles.root}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={[styles.container, { paddingBottom: SPACING[6] + insets.bottom }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        testID="tailscale-login-screen"
      >
        <View style={styles.content}>
          <JAgentDeskLogo size={96} />
          <View style={styles.copyBlock}>
            <Text style={styles.title}>
              {adapter.isSupported
                ? t("tailscaleLogin.title")
                : t("tailscaleLogin.unavailableTitle")}
            </Text>
            <Text style={styles.subtitle}>
              {adapter.isSupported
                ? t("tailscaleLogin.subtitle")
                : t("tailscaleLogin.unavailableBody")}
            </Text>
          </View>

          {isDesktopLogin ? (
            <View style={styles.card}>
              <Text style={styles.fieldLabel}>Connect type</Text>
              <View style={styles.connectionTypeRow}>
                <Button
                  variant={connectionType === "tailscale" ? "default" : "secondary"}
                  onPress={() => setConnectionType("tailscale")}
                  testID="connection-type-tailscale"
                >
                  Tailscale (default)
                </Button>
                <Button
                  variant={connectionType === "local" ? "default" : "secondary"}
                  onPress={() => setConnectionType("local")}
                  testID="connection-type-local"
                >
                  Local
                </Button>
              </View>
            </View>
          ) : null}

          {connectionType === "local" || showLocalFallback ? (
            <View style={styles.card}>
              <Text style={styles.subtitle}>
                {showLocalFallback
                  ? "This mobile build cannot embed Tailscale yet. Use Local pairing, or install the supported iOS build."
                  : "Use the local JAgentDesk daemon on this computer."}
              </Text>
              <Button
                variant="default"
                size="lg"
                onPress={async () => {
                  await setConnectionMode("local");
                  router.replace("/");
                }}
                testID="connection-local-continue"
              >
                Continue with Local
              </Button>
            </View>
          ) : adapter.isSupported ? (
            <>
              <View style={styles.card}>
                <Button
                  variant="default"
                  size="lg"
                  leftIcon={<TailscaleMark />}
                  onPress={handleInteractiveLogin}
                  loading={interactiveInProgress}
                  disabled={authKeyInProgress}
                  testID="tailscale-login-interactive"
                >
                  {interactiveInProgress
                    ? t("tailscaleLogin.interactiveInProgress")
                    : t("tailscaleLogin.interactiveAction")}
                </Button>

                {interactiveInProgress ? (
                  <Text style={styles.connectingText} testID="tailscale-login-connecting">
                    {t("tailscaleLogin.connecting")}
                  </Text>
                ) : null}

                <View style={styles.divider} />

                <Text style={styles.fieldLabel}>{t("tailscaleLogin.authKeyLabel")}</Text>
                <TextInput
                  ref={authKeyInputRef}
                  value={authKey}
                  onChangeText={setAuthKey}
                  placeholder={t("tailscaleLogin.authKeyPlaceholder")}
                  placeholderTextColor={styles.placeholderColor.color}
                  style={styles.input}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  textContentType={isNative ? "oneTimeCode" : undefined}
                  editable={!busy}
                  testID="tailscale-login-authkey-input"
                />
                <Button
                  variant="secondary"
                  size="lg"
                  leftIcon={KeyRound}
                  onPress={handleAuthKeySubmit}
                  loading={authKeyInProgress}
                  disabled={interactiveInProgress}
                  testID="tailscale-login-authkey-submit"
                >
                  {authKeyInProgress
                    ? t("tailscaleLogin.authKeyInProgress")
                    : t("tailscaleLogin.authKeyAction")}
                </Button>
              </View>

              {error ? (
                <Text style={styles.error} testID="tailscale-login-error">
                  {error}
                </Text>
              ) : null}
            </>
          ) : null}

          <Text style={styles.note}>{t("tailscaleLogin.sameTailnetNote")}</Text>
        </View>
      </ScrollView>
    </View>
  );
}
