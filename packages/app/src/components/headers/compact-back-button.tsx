import { useRouter } from "expo-router";
import { useCallback } from "react";
import { Pressable } from "react-native";
import { ArrowLeft } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";

const ThemedArrowLeft = withUnistyles(ArrowLeft);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * The phone back arrow every full-screen page leads with (the Docker screen's pattern). Goes back
 * in history, or home when the page was opened directly. Renders nothing on desktop, where the
 * sidebar / rail is always there.
 */
export function CompactBackButton({ testID = "screen-back" }: { testID?: string }) {
  const isCompact = useIsCompactFormFactor();
  const router = useRouter();
  const handleBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }, [router]);
  if (!isCompact) return null;
  return (
    <Pressable
      style={styles.button}
      onPress={handleBack}
      accessibilityRole="button"
      accessibilityLabel="Back"
      hitSlop={8}
      testID={testID}
    >
      <ThemedArrowLeft size={20} uniProps={mutedColorMapping} />
    </Pressable>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  button: {
    width: 32,
    height: 32,
    marginLeft: -theme.spacing[1],
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
}));
