import { useSasKeyboard } from "@/pairing/use-sas-keyboard";
import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import {
  createWebSocketTransportFactory,
  createRelayE2eeTransportFactory,
  defaultWebSocketFactory,
} from "@jagentdesk/client/internal/daemon-client-transport";
import { BackHeader } from "@/components/headers/back-header";
import { Button } from "@/components/ui/button";
import { useHostMutations } from "@/runtime/host-runtime";
import { buildClientConfig, connectToDaemon } from "@/utils/test-daemon-connection";
import { getRelayDeviceSigning, prepareRelayDeviceSigning } from "@/utils/relay-device-signing";
import { getMobileDeviceName } from "@/utils/device-identity";
import { connectionsFromOffer, relayConnectionFromOffer } from "@/types/host-connection";
import {
  getTailnetMode,
  getTailscaleLoginAdapter,
  resolvePairVerifyDecision,
  setTailnetMode,
  tailnetModeAfterPairing,
  useTailscaleLoginStatus,
} from "@/tailscale";
import {
  clearPendingPairingOffer,
  loadPendingPairingOffer,
  savePendingPairingOffer,
} from "@/pairing/pending-pairing-offer";
import { parseAppPairingOffer } from "@/pairing/offer";
import { pairAppDevice } from "@/pairing/sas-client";

export default function PairVerifyScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ offer?: string; source?: string }>();
  const { upsertConnectionFromOffer } = useHostMutations();
  const status = useTailscaleLoginStatus();
  const [pending, setPending] = useState<{
    offerUrl: string;
    source: "onboarding" | "settings";
  } | null>(null);
  const [hostLabel, setHostLabel] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const setSasScope = useSasKeyboard(code !== null && error === null);
  const confirmation = useRef<((accepted: boolean) => void) | null>(null);
  const abort = useRef<AbortController | null>(null);
  const started = useRef(false);
  const [remaining, setRemaining] = useState(120);
  const offerUrl = typeof params.offer === "string" ? params.offer : "";
  const source: "onboarding" | "settings" =
    params.source === "onboarding" ? "onboarding" : "settings";
  useEffect(() => {
    let active = true;
    void (async () => {
      const next = offerUrl ? { offerUrl, source } : await loadPendingPairingOffer();
      if (!next) throw new Error("Paste or scan a new pairing link from the host.");
      await savePendingPairingOffer(next);
      if (active) setPending(next);
    })().catch((reason) => {
      if (active) setError(String(reason));
    });
    return () => {
      active = false;
    };
  }, [offerUrl, source]);
  useEffect(() => {
    if (!pending || started.current) return;
    let parsed: ReturnType<typeof parseAppPairingOffer>;
    try {
      parsed = parseAppPairingOffer(pending.offerUrl);
    } catch (reason) {
      setError(String(reason));
      return;
    }
    const { offer, pk, local } = parsed;
    setHostLabel(offer.tailnetAddress ?? offer.serverId);
    const decision = resolvePairVerifyDecision({ hasRelay: !!offer.relay, local, status });
    if (decision.kind === "tailscale-login") {
      // ADR-0056: a tailnet-only link needs this device on the tailnet; sign-in returns here.
      router.replace("/tailscale-login?returnTo=pair-verify" as Href);
      return;
    }
    if (decision.kind === "wait") return;
    const route = decision.route;
    started.current = true;
    const controller = new AbortController();
    abort.current = controller;
    const deadline = performance.now() + 120000;
    const timer = setInterval(() => {
      const seconds = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
      setRemaining(seconds);
      if (seconds === 0) {
        setError("Pairing expired. Generate a new link on the host.");
        controller.abort();
      }
    }, 1000);
    void (async () => {
      await prepareRelayDeviceSigning();
      const signing = getRelayDeviceSigning();
      if (!signing) throw new Error("Device signing is unavailable on this device.");
      const connection = offer.relay
        ? relayConnectionFromOffer(offer)
        : connectionsFromOffer(offer)[0];
      if (!connection) throw new Error("Pairing link has no route");
      const config = await buildClientConfig(connection, offer.serverId);
      const baseFactory = createWebSocketTransportFactory(
        config.webSocketFactory ?? defaultWebSocketFactory,
      );
      const factory = offer.relay
        ? createRelayE2eeTransportFactory({
            baseFactory,
            daemonPublicKeyB64: offer.daemonPublicKeyB64,
            minimumMode: "protected",
            logger: { warn() {} },
          })
        : baseFactory;
      const url = config.url;
      await pairAppDevice({
        transport: factory({ url }),
        pk,
        publicKey: signing.devicePublicKeyB64,
        label: getMobileDeviceName() ?? "",
        kind: getTailscaleLoginAdapter().platform === "desktop" ? "desktop" : "mobile",
        signal: controller.signal,
        compare: (nextCode) =>
          new Promise<boolean>((resolve) => {
            setCode(nextCode);
            confirmation.current = resolve;
          }),
      });
      clearInterval(timer);
      if (controller.signal.aborted) return;
      const result = await connectToDaemon(connection, {
        serverId: offer.serverId,
        signal: controller.signal,
      });
      try {
        if (result.client.getLastServerInfoMessage()?.serverId !== offer.serverId)
          throw new Error("Host identity changed");
      } finally {
        await result.client.close();
      }
      await setTailnetMode(tailnetModeAfterPairing({ route, current: await getTailnetMode() }));
      const profile = await upsertConnectionFromOffer(offer, undefined);
      await clearPendingPairingOffer();
      router.replace(
        (pending.source === "onboarding"
          ? "/open-project"
          : `/settings/hosts/${profile.serverId}`) as Href,
      );
    })()
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => clearInterval(timer));
    // Connection state changes do not replace an exchange which already owns its socket.
  }, [pending, status, router, upsertConnectionFromOffer]);
  useEffect(
    () => () => {
      confirmation.current?.(false);
      abort.current?.abort();
    },
    [],
  );
  const accept = useCallback(() => {
    setConfirmed(true);
    confirmation.current?.(true);
    confirmation.current = null;
  }, []);
  const cancel = useCallback(() => {
    confirmation.current?.(false);
    abort.current?.abort();
    void clearPendingPairingOffer();
    router.back();
  }, [router]);
  return (
    <View style={styles.container}>
      {!code || error ? <BackHeader title="Pair a device" onBack={cancel} /> : null}
      <View style={styles.center}>
        <View ref={setSasScope} style={styles.card} testID="pairing-card">
          <Text style={styles.title}>
            {code ? "Do these codes match?" : "Connecting to the host…"}
          </Text>
          {error ? (
            <Text style={styles.error} testID="pairing-error">
              {error}
            </Text>
          ) : null}
          {code && !error ? (
            <>
              <Text style={styles.code} testID="pairing-sas-code">
                {code.slice(0, 3)} {code.slice(3)}
              </Text>
              <Text style={styles.text}>
                Shown on {hostLabel}. Compare the code on both screens. If they are different,
                cancel.
              </Text>
              <Text style={styles.muted}>Expires in {remaining}s</Text>
            </>
          ) : null}
          <View style={styles.actions}>
            {code && !error && confirmed ? (
              <Text style={styles.text}>Waiting for the other device…</Text>
            ) : null}
            {code && !error && !confirmed ? (
              <Button variant="default" onPress={accept} style={styles.button}>
                Codes match
              </Button>
            ) : null}
            <Button variant="outline" onPress={cancel} style={styles.button}>
              Cancel
            </Button>
          </View>
        </View>
      </View>
    </View>
  );
}
/** A centered card (spec 38 §4.6 modal): 480 wide at most, 18/600 title, 44 px buttons. */
const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.surface0 },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  card: {
    width: "100%",
    maxWidth: 480,
    padding: theme.spacing[6],
    gap: theme.spacing[3],
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    ...theme.shadow.lg,
  },
  title: { fontSize: 18, fontWeight: "600", color: theme.colors.foreground },
  text: { fontSize: theme.fontSize.base, color: theme.colors.foregroundMuted },
  muted: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  code: {
    fontSize: 40,
    lineHeight: 52,
    letterSpacing: 4,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
    textAlign: "center",
    paddingVertical: theme.spacing[2],
  },
  actions: { gap: 12, marginTop: theme.spacing[2] },
  button: { minHeight: 44 },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.base },
}));
