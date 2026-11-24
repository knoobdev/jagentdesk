import { useCallback, useEffect, useState } from "react";
import { Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { SessionOutboundMessage } from "@jagentdesk/protocol/messages";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const spinnerProps = (theme: import("@/styles/theme").Theme) => ({
  color: theme.colors.foregroundMuted,
});
type SasState = Extract<SessionOutboundMessage, { type: "pairing.sas.changed" }>["payload"];
export function PairDaemonSection({ serverId, onClose }: { serverId: string; onClose(): void }) {
  const client = useHostRuntimeClient(serverId);
  const [offer, setOffer] = useState<{ link: string; pk: string; expiresAt: number } | null>(null);
  const [state, setState] = useState<SasState | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [generation, setGeneration] = useState(0);
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
      if (active) setState(message.payload);
    });
    void client
      .beginSasPairing()
      .then((result) => {
        pk = result.pk;
        if (active) setOffer(result);
        else void client.confirmSasPairing(pk, false).catch(() => {});
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
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const expired = offer !== null && now >= offer.expiresAt;
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
    if (offer) void Clipboard.setStringAsync(offer.link);
  }, [offer]);
  if (state?.state === "completed")
    return (
      <View style={styles.content}>
        <Text style={styles.title}>Device paired</Text>
        <Text style={styles.text}>{state.label ?? "The daemon"} can now control this host.</Text>
        <Button onPress={onClose}>Done</Button>
      </View>
    );
  if (error || expired || state?.state === "cancelled")
    return (
      <View style={styles.content}>
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
      <View style={styles.content}>
        <ThemedLoadingSpinner uniProps={spinnerProps} />
        <Button variant="outline" onPress={onClose}>
          Cancel
        </Button>
      </View>
    );
  if (state?.code)
    return (
      <View style={styles.content}>
        <Text style={styles.title}>Do these codes match?</Text>
        <Text style={styles.text}>Verification code</Text>
        <Text style={styles.code}>
          {state.code.slice(0, 3)} {state.code.slice(3)}
        </Text>
        <Text style={styles.text}>Shown on {state.label || "the other daemon"}</Text>
        <Text style={styles.text}>
          Compare the code on both screens. If they are different, cancel.
        </Text>
        <Text style={styles.text}>
          Expires in {Math.max(0, Math.ceil((offer.expiresAt - now) / 1000))}s
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
    <View style={styles.content}>
      <Text style={styles.title}>Pair a daemon</Text>
      <Text style={styles.text}>
        On the other host, run jagentdesk host add with this link. Both devices must confirm the
        same verification code.
      </Text>
      <TextInput value={offer.link} editable={false} multiline style={styles.link} />
      <Text style={styles.text}>
        Expires in {Math.max(0, Math.ceil((offer.expiresAt - now) / 1000))}s
      </Text>
      <Button onPress={copy}>Copy pairing link</Button>
      <Button variant="outline" onPress={onClose}>
        Cancel
      </Button>
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
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
