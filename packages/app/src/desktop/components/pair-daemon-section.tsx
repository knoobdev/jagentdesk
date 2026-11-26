import { useSasKeyboard } from "@/pairing/use-sas-keyboard";
import * as QRCode from "qrcode";
import { SvgXml } from "react-native-svg";
import { useCallback, useEffect, useState } from "react";
import { Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { SessionOutboundMessage } from "@jagentdesk/protocol/messages";
import { parseHostTarget } from "@jagentdesk/protocol/host-target";
import { useRouter, type Href } from "expo-router";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const spinnerProps = (theme: import("@/styles/theme").Theme) => ({
  color: theme.colors.foregroundMuted,
});
type SasState = Extract<SessionOutboundMessage, { type: "pairing.sas.changed" }>["payload"];

/**
 * True when the link reaches the daemon only over loopback: relay is off and
 * the daemon is not on the tailnet. Another daemon on this computer can still
 * use it; a phone cannot (spec `05.2.5`).
 */
export function isLoopbackOnlyPairingLink(link: string): boolean {
  try {
    return parseHostTarget(link).via === "local";
  } catch {
    return false;
  }
}

export function PairDaemonSection({ serverId, onClose }: { serverId: string; onClose(): void }) {
  const client = useHostRuntimeClient(serverId);
  const [qr, setQr] = useState<string | null>(null);
  const [offer, setOffer] = useState<{ link: string; pk: string; expiresAt: number } | null>(null);
  const [state, setState] = useState<SasState | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const setSasScope = useSasKeyboard(state?.state === "comparing");
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(performance.now());
  const [deadline, setDeadline] = useState<number | null>(null);
  const [generation, setGeneration] = useState(0);
  const router = useRouter();
  const openTailscaleSignIn = useCallback(() => {
    onClose();
    router.push("/tailscale-login" as Href);
  }, [onClose, router]);
  useEffect(() => {
    if (!client) return;
    let active = true;
    let pk: string | undefined;
    let completed = false;
    setOffer(null);
    setState(null);
    setError(null);
    setConfirmed(false);
    const stop = client.subscribeRawMessages((message) => {
      if (message.type !== "pairing.sas.changed" || message.payload.pk !== pk) return;
      completed = message.payload.state === "completed";
      if (active) setState((previous) => ({ ...previous, ...message.payload }));
    });
    void client
      .beginSasPairing()
      .then((result) => {
        pk = result.pk;
        if (active) {
          setOffer(result);
          setDeadline(performance.now() + Math.max(0, result.expiresAt - Date.now()));
          void QRCode.toString(result.link, { type: "svg", errorCorrectionLevel: "M", margin: 4 })
            .then((svg) => {
              if (active) setQr(svg);
              return undefined;
            })
            .catch(() => {
              if (active) setError("Unable to generate pairing QR code");
            });
        } else void client.confirmSasPairing(pk, false).catch(() => {});
        return undefined;
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
      stop();
      if (pk && !completed) void client.confirmSasPairing(pk, false).catch(() => {});
    };
  }, [client, generation]);
  useEffect(() => {
    const timer = setInterval(() => setNow(performance.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const expired = deadline !== null && now >= deadline;
  const confirm = useCallback(async () => {
    if (!client || !offer) return;
    try {
      await client.confirmSasPairing(offer.pk, true);
      setConfirmed(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [client, offer]);
  const confirmPress = useCallback(() => {
    void confirm();
  }, [confirm]);
  const generate = useCallback(() => setGeneration((value) => value + 1), []);
  const copy = useCallback(() => {
    if (offer)
      void Clipboard.setStringAsync(offer.link).catch(() =>
        setError("Unable to copy pairing link"),
      );
  }, [offer]);
  if (state?.state === "completed")
    return (
      <View ref={setSasScope} style={styles.content}>
        <Text style={styles.title}>Device paired</Text>
        <Text style={styles.text}>{state.label ?? "The device"} can now control this host.</Text>
        <Button onPress={onClose}>Done</Button>
      </View>
    );
  if (error || expired || state?.state === "cancelled")
    return (
      <View ref={setSasScope} style={styles.content}>
        <Alert
          variant="warning"
          title={expired ? "Pairing code expired" : "Pairing unavailable"}
          description={error ?? "Generate a new code and try again."}
        />
        <Button onPress={generate}>Generate a new code</Button>
        <Button variant="outline" onPress={onClose}>
          Cancel
        </Button>
      </View>
    );
  if (!offer)
    return (
      <View ref={setSasScope} style={styles.content}>
        <ThemedLoadingSpinner uniProps={spinnerProps} />
        <Button variant="outline" onPress={onClose}>
          Cancel
        </Button>
      </View>
    );
  if (state?.code)
    return (
      <View ref={setSasScope} style={styles.content}>
        <Text style={styles.title}>Do these codes match?</Text>
        <Text style={styles.text}>Verification code</Text>
        <Text style={styles.code}>
          {state.code.slice(0, 3)} {state.code.slice(3)}
        </Text>
        <Text style={styles.text}>Shown on {state.label || "the other device"}</Text>
        <Text style={styles.text}>
          Compare the code on both screens. If they are different, cancel.
        </Text>
        <Text style={styles.text}>
          Expires in {Math.max(0, Math.ceil(((deadline ?? now) - now) / 1000))}s
        </Text>
        {confirmed ? (
          <Text style={styles.text}>Waiting for the other device...</Text>
        ) : (
          <Button variant="default" onPress={confirmPress}>
            Codes match
          </Button>
        )}
        <Button variant="outline" onPress={onClose}>
          Cancel
        </Button>
      </View>
    );
  return (
    <View ref={setSasScope} style={styles.content}>
      <Text style={styles.title}>Pair a device</Text>
      <Text style={styles.text}>
        Scan the QR code or paste this link on the other device. Both devices must confirm the same
        verification code.
      </Text>
      <LoopbackPairingWarning link={offer.link} onSignIn={openTailscaleSignIn} />
      {qr ? (
        <View style={styles.qr}>
          <SvgXml xml={qr} width={240} height={240} />
        </View>
      ) : null}
      <TextInput value={offer.link} editable={false} multiline style={styles.link} />
      <Text style={styles.text}>
        Expires in {Math.max(0, Math.ceil(((deadline ?? now) - now) / 1000))}s
      </Text>
      <Button onPress={copy}>Copy pairing link</Button>
      <Button variant="outline" onPress={onClose}>
        Cancel
      </Button>
    </View>
  );
}
function LoopbackPairingWarning({ link, onSignIn }: { link: string; onSignIn(): void }) {
  if (!isLoopbackOnlyPairingLink(link)) return null;
  return (
    <>
      <Alert
        variant="warning"
        title="This link only works on this computer"
        description="Relay is off and this computer is not on your tailnet. To pair a phone, sign in to Tailscale or turn relay on."
      />
      <Button variant="secondary" onPress={onSignIn}>
        Sign in to Tailscale
      </Button>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  qr: { alignSelf: "center", backgroundColor: "#ffffff" },
  content: { gap: theme.spacing[3], padding: theme.spacing[4] },
  title: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  text: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  code: {
    fontSize: 40,
    letterSpacing: 4,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
    textAlign: "center",
  },
  link: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
  },
}));
