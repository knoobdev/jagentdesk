import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { useRouter, type Href } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/ui/button";
import { JAgentDeskLogo } from "@/components/icons/jagentdesk-logo";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { ConnectWorkstationOptions } from "@/components/connect-workstation";

export type ConnectWorkstationStep = "welcome" | "connect";

/**
 * First-run onboarding (spec `05.2.2`, ADR-0056): màn 1 "Welcome to JAgentDesk"
 * then màn 4 "Connect your workstation". There is no transport chooser; the
 * pairing link decides relay and/or tailnet.
 */
export function ConnectWorkstationScreen({
  initialStep = "welcome",
}: {
  initialStep?: ConnectWorkstationStep;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState<ConnectWorkstationStep>(initialStep);

  const handleGetStarted = useCallback(() => setStep("connect"), []);
  const handleScanQr = useCallback(() => {
    router.push("/pair-scan?source=onboarding" as Href);
  }, [router]);
  const handlePasteLink = useCallback(() => {
    router.push("/pair-link?source=onboarding" as Href);
  }, [router]);
  const handleSignInTailscale = useCallback(() => {
    router.push("/tailscale-login?returnTo=pair-start" as Href);
  }, [router]);

  return (
    <View style={styles.root}>
      <TitlebarDragRegion />
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={[styles.container, { paddingBottom: insets.bottom + 24 }]}
        showsVerticalScrollIndicator={false}
        testID={step === "welcome" ? "onboarding-welcome" : "connect-workstation-screen"}
      >
        <View style={styles.content}>
          <JAgentDeskLogo size={72} />
          {step === "welcome" ? (
            <>
              <View style={styles.copy}>
                <Text style={styles.title}>{t("onboarding.title")}</Text>
                <Text style={styles.subtitle}>{t("onboarding.welcomeDescription")}</Text>
              </View>
              <Button
                variant="default"
                size="lg"
                style={styles.primaryButton}
                onPress={handleGetStarted}
                testID="onboarding-get-started"
              >
                {t("onboarding.getStarted")}
              </Button>
            </>
          ) : (
            <>
              <View style={styles.copy}>
                <Text style={styles.title}>{t("onboarding.connectTitle")}</Text>
              </View>
              <ConnectWorkstationOptions
                onScanQr={handleScanQr}
                onPasteLink={handlePasteLink}
                onSignInTailscale={handleSignInTailscale}
              />
              <Text style={styles.footer} testID="connect-workstation-footer">
                {t("onboarding.connectFooter")}
              </Text>
            </>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

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
    alignItems: "center",
    justifyContent: "center",
  },
  content: {
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
    fontWeight: theme.fontWeight.semibold,
    textAlign: "center",
  },
  subtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  primaryButton: {
    alignSelf: "stretch",
    minHeight: 44,
    borderRadius: 10,
  },
  footer: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
