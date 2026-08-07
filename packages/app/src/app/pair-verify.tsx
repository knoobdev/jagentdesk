import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { BackHeader } from "@/components/headers/back-header";
import { useHostMutations } from "@/runtime/host-runtime";
import { connectToDaemon } from "@/utils/test-daemon-connection";
import { decodeOfferFragmentPayload, normalizeHostPort } from "@/utils/daemon-endpoints";
import { ConnectionOfferSchema } from "@jagentdesk/protocol/connection-offer";
import {
  isTailscaleReady,
  setConnectionMode,
  shouldRoutePairVerifyToTailscaleLogin,
  useTailscaleLoginStatus,
} from "@/tailscale";
import {
  clearPendingPairingOffer,
  loadPendingPairingOffer,
  savePendingPairingOffer,
} from "@/pairing/pending-pairing-offer";

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.surface0 },
  body: { padding: theme.spacing[6], gap: theme.spacing[6] },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.bold,
  },
  helper: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  placeholderColor: { color: theme.colors.foregroundMuted },
  input: {
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[4],
    fontSize: theme.fontSize.xl,
    letterSpacing: 5,
    textAlign: "center",
  },
}));

export default function PairVerifyScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ offer?: string; source?: string }>();
  const { upsertConnectionFromOffer } = useHostMutations();
  const tailscaleLoginStatus = useTailscaleLoginStatus();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingOffer, setPendingOffer] = useState<{
    offerUrl: string;
    source: "onboarding" | "settings";
  } | null>(null);
  const [offerPersisted, setOfferPersisted] = useState(false);
  const pairingCodeResolverRef = useRef<((value: string) => void) | null>(null);
  const pairingCodeRejecterRef = useRef<((error: Error) => void) | null>(null);
  const submittedPairingCodeRef = useRef<string | null>(null);
  const resolvedCodeRef = useRef<string | null>(null);
  const verificationInFlightRef = useRef(false);
  const connectionAttemptRef = useRef<Promise<{
    client: Awaited<ReturnType<typeof connectToDaemon>>["client"];
  }> | null>(null);
  const connectionAttemptAbortControllerRef = useRef<AbortController | null>(null);

  const parameterOfferUrl = typeof params.offer === "string" ? params.offer : "";
  const parameterSource = params.source === "onboarding" ? "onboarding" : "settings";

  useEffect(() => {
    let active = true;
    if (parameterOfferUrl) {
      const next = {
        offerUrl: parameterOfferUrl,
        source: parameterSource as "onboarding" | "settings",
      };
      setOfferPersisted(false);
      void (async () => {
        try {
          await savePendingPairingOffer(next);
          if (!active) return;
          setPendingOffer(next);
          setOfferPersisted(true);
        } catch {
          if (!active) return;
          // Keep the route payload in memory so the user can recover without
          // silently entering a login loop with no offer after navigation.
          setPendingOffer(next);
          setOfferPersisted(false);
          Alert.alert(
            "Pairing failed",
            "JAgentDesk could not save the pairing offer on this device. Paste the link again to retry.",
          );
        }
      })();
      return () => {
        active = false;
      };
    }

    void (async () => {
      const stored = await loadPendingPairingOffer();
      if (!active) return;
      if (stored) setPendingOffer(stored);
      setOfferPersisted(true);
    })();
    return () => {
      active = false;
    };
  }, [parameterOfferUrl, parameterSource]);

  const offerUrl = pendingOffer?.offerUrl ?? parameterOfferUrl;
  const source = pendingOffer?.source ?? parameterSource;
  const pairingCodeProvider = useCallback((): Promise<string> => {
    if (submittedPairingCodeRef.current) {
      resolvedCodeRef.current = submittedPairingCodeRef.current;
      return Promise.resolve(submittedPairingCodeRef.current);
    }
    return new Promise((resolve, reject) => {
      pairingCodeResolverRef.current = resolve;
      pairingCodeRejecterRef.current = reject;
    });
  }, []);

  const offer = useMemo(() => {
    try {
      const marker = "#offer=";
      const index = offerUrl.indexOf(marker);
      if (index < 0) return null;
      return ConnectionOfferSchema.parse(
        decodeOfferFragmentPayload(offerUrl.slice(index + marker.length)),
      );
    } catch {
      return null;
    }
  }, [offerUrl]);

  const tailscaleReady = isTailscaleReady(tailscaleLoginStatus);
  const shouldRouteToLogin = shouldRoutePairVerifyToTailscaleLogin(tailscaleLoginStatus);
  const [attemptError, setAttemptError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pairingCodeRejecterRef.current?.(new Error("Pairing screen closed"));
      pairingCodeResolverRef.current = null;
      pairingCodeRejecterRef.current = null;
      submittedPairingCodeRef.current = null;
      connectionAttemptAbortControllerRef.current?.abort();
      connectionAttemptAbortControllerRef.current = null;
      connectionAttemptRef.current = null;
      verificationInFlightRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!offer || !offerPersisted || !shouldRouteToLogin) {
      return;
    }
    router.replace("/tailscale-login?returnTo=pair-verify" as Href);
  }, [offer, offerPersisted, router, shouldRouteToLogin]);

  const createConnectionAttempt = useCallback(
    (pairingCode?: string) => {
      if (!offer) return null;
      if (connectionAttemptRef.current && !pairingCode) return connectionAttemptRef.current;
      if (pairingCode) {
        pairingCodeRejecterRef.current?.(new Error("Pairing confirmation socket replaced"));
        pairingCodeResolverRef.current = null;
        pairingCodeRejecterRef.current = null;
        connectionAttemptAbortControllerRef.current?.abort();
        connectionAttemptAbortControllerRef.current = null;
        connectionAttemptRef.current = null;
      }
      const connection = {
        id: `tailnet:${normalizeHostPort(offer.tailnetAddress)}`,
        type: "tailnet" as const,
        tailnetAddress: normalizeHostPort(offer.tailnetAddress),
        useTls: offer.useTls,
        daemonPublicKeyB64: offer.daemonPublicKeyB64,
        ...(pairingCode ? { pairingCode } : {}),
      };
      const abortController = new AbortController();
      connectionAttemptAbortControllerRef.current = abortController;
      const attempt = connectToDaemon(connection, {
        serverId: offer.serverId,
        timeoutMs: 5 * 60 * 1000,
        connectTimeoutMs: 5 * 60 * 1000,
        ...(pairingCode ? {} : { pairingCodeProvider }),
        signal: abortController.signal,
      });
      connectionAttemptRef.current = attempt;
      setAttemptError(null);
      void attempt
        .then(() => undefined)
        .catch((error) => {
          if (connectionAttemptRef.current !== attempt) return;
          connectionAttemptRef.current = null;
          connectionAttemptAbortControllerRef.current = null;
          // A failed attempt must not wedge the screen: clear the ref and the
          // armed code resolver so a fresh 6-digit entry starts a new attempt.
          if (!mountedRef.current) return;
          pairingCodeResolverRef.current = null;
          pairingCodeRejecterRef.current = null;
          submittedPairingCodeRef.current = null;
          resolvedCodeRef.current = null;
          setCode("");
          setAttemptError(error instanceof Error ? error.message : String(error));
        });
      return attempt;
    },
    [offer, pairingCodeProvider],
  );

  useEffect(() => {
    if (!tailscaleReady || !offer) return;
    if (connectionAttemptRef.current) return;
    createConnectionAttempt();
  }, [tailscaleReady, offer, createConnectionAttempt]);

  const verify = useCallback(
    async (submittedCode: string) => {
      if (verificationInFlightRef.current) return;
      if (!offer) {
        Alert.alert("Pairing failed", "This is not a valid JAgentDesk Tailscale offer.");
        return;
      }
      if (!/^\d{6}$/.test(submittedCode)) {
        Alert.alert("Pairing failed", "Enter the 6-digit verification code shown on desktop.");
        return;
      }
      verificationInFlightRef.current = true;
      setBusy(true);
      try {
        submittedPairingCodeRef.current = submittedCode;
        // The six-digit entry is the explicit confirmation signal. Replace
        // the socket that was only waiting to announce the device with a
        // fresh registration socket carrying this code directly.
        const connectionAttempt = createConnectionAttempt(submittedCode);
        if (!connectionAttempt) {
          throw new Error("Tailscale connection is still starting. Try entering the code again.");
        }
        resolvedCodeRef.current = submittedCode;
        const { client } = await connectionAttempt;
        await client.close().catch(() => undefined);
        // This is explicitly a tailnet pairing flow. Persist that transport
        // choice before storing the host so runtime cannot probe a stale Local
        // connection immediately after the offer is accepted.
        await setConnectionMode("tailscale");
        // The code is a one-time enrollment proof, not a host connection secret.
        // Store only the offer metadata; reconnects authenticate with the
        // persisted device key and never replay the six-digit proof.
        const profile = await upsertConnectionFromOffer(offer, undefined);
        await clearPendingPairingOffer();
        router.replace(
          (source === "onboarding"
            ? "/open-project"
            : `/settings/hosts/${profile.serverId}`) as Href,
        );
      } catch (error) {
        Alert.alert("Pairing failed", error instanceof Error ? error.message : String(error));
      } finally {
        verificationInFlightRef.current = false;
        setBusy(false);
      }
    },
    [createConnectionAttempt, offer, router, source, upsertConnectionFromOffer],
  );

  const handleCodeChange = useCallback(
    (value: string) => {
      const nextCode = value.replace(/\D/g, "").slice(0, 6);
      setCode(nextCode);
      if (/^\d{6}$/.test(nextCode)) {
        void verify(nextCode);
      }
    },
    [verify],
  );
  const handleBack = useCallback(() => router.back(), [router]);

  let helperText = "Waiting for Tailscale to connect...";
  if (tailscaleReady) {
    helperText = "Enter the 6-digit code shown in the JAgentDesk desktop connection popup.";
  } else if (shouldRouteToLogin) {
    helperText =
      "Pairing offer saved. Sign in to Tailscale first; then this screen will connect to the desktop and ask for the 6-digit code.";
  }

  return (
    <View style={styles.container}>
      <BackHeader title="Verify pairing" onBack={handleBack} />
      <View style={styles.body}>
        <Text style={styles.title}>Enter verification code</Text>
        <Text style={styles.helper}>{helperText}</Text>
        {attemptError ? <Text style={styles.error}>{attemptError}</Text> : null}
        <TextInput
          testID="pairing-code-input"
          value={code}
          onChangeText={handleCodeChange}
          keyboardType="number-pad"
          maxLength={6}
          autoFocus
          placeholder="000000"
          placeholderTextColor={styles.placeholderColor.color}
          style={styles.input}
        />
        {busy ? <Text style={styles.helper}>Verifying…</Text> : null}
      </View>
    </View>
  );
}
