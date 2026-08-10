import { useCallback, useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useRouter, type Href } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/ui/button";
import { JAgentDeskLogo } from "@/components/icons/jagentdesk-logo";
import { isNative } from "@/constants/platform";
import { loadPendingPairingOffer } from "@/pairing/pending-pairing-offer";
import { setConnectionMode } from "@/tailscale";

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  content: {
    flexGrow: 1,
    padding: theme.spacing[6],
    alignItems: "center",
    justifyContent: "center",
  },
  inner: {
    width: "100%",
    maxWidth: 420,
    alignItems: "center",
    gap: theme.spacing[6],
  },
  copy: {
    alignItems: "center",
    gap: theme.spacing[2],
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
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  helper: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));

export default function PairStartScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [pendingChecked, setPendingChecked] = useState(false);
  const handleScanPress = useCallback(() => {
    router.push("/pair-scan?source=onboarding");
  }, [router]);
  const handleLinkPress = useCallback(() => {
    router.push("/pair-link?source=onboarding" as Href);
  }, [router]);
  const handleLocalPress = useCallback(async () => {
    await setConnectionMode("local");
    router.replace("/");
  }, [router]);

  useEffect(() => {
    let active = true;
    void loadPendingPairingOffer()
      .then((pending) => {
        if (!active) return undefined;
        if (pending) {
          router.replace("/pair-verify" as Href);
          return undefined;
        }
        setPendingChecked(true);
        return undefined;
      })
      .catch(() => {
        if (active) setPendingChecked(true);
      });
    return () => {
      active = false;
    };
  }, [router]);

  if (!pendingChecked) {
    return <View style={styles.root} />;
  }

  return (
    <View style={styles.root}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.inner}>
          <JAgentDeskLogo size={96} />
          <View style={styles.copy}>
            <Text style={styles.title}>Connect to JAgentDesk</Text>
            <Text style={styles.subtitle}>
              Pair with your desktop first. Tailscale login comes next, then JAgentDesk asks for the
              6-digit code.
            </Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.label}>Tailscale connection</Text>
            <Text style={styles.helper}>Choose one way to receive the desktop pairing offer.</Text>
            <Button variant="default" size="lg" onPress={handleScanPress} testID="pair-start-scan">
              Scan desktop QR
            </Button>
            <Button
              variant="secondary"
              size="lg"
              onPress={handleLinkPress}
              testID="pair-start-link"
            >
              Paste pairing link
            </Button>
          </View>

          {/* ADR-0010: a native mobile device is never co-located with the
              daemon, so "local" is meaningless there and must not be an
              unauthenticated control path. Only offer it where the app can run
              on the same machine as the daemon (desktop/web). */}
          {isNative ? null : (
            <View style={styles.card}>
              <Text style={styles.label}>Local connection</Text>
              <Text style={styles.helper}>Use the local JAgentDesk daemon on this computer.</Text>
              <Button
                variant="secondary"
                size="lg"
                onPress={handleLocalPress}
                testID="pair-start-local"
              >
                Continue with Local
              </Button>
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}
