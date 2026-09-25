import type { ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { ThemedGradientFill } from "./gradient-fill";

export const CLICKUP_COMPOSER_RADIUS = 12;
const FRAME_WIDTH = 1.5;

const composerGradientMapping = (theme: Theme) => ({
  colors: theme.chrome.composerGradient.join(","),
});
const sendGradientMapping = (theme: Theme) => ({ colors: theme.chrome.sendGradient.join(",") });

/**
 * ClickUp Brain's composer border: a 1.5px cyan → violet → magenta gradient running from the
 * bottom-left to the top-right corner. Renders children untouched when disabled.
 */
export function ClickUpComposerFrame({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  if (!enabled) return children;
  return (
    <View style={styles.frame}>
      <ThemedGradientFill
        direction="diagonal-up"
        radius={CLICKUP_COMPOSER_RADIUS + FRAME_WIDTH}
        uniProps={composerGradientMapping}
      />
      {children}
    </View>
  );
}

/** The violet → magenta fill of ClickUp Brain's square send button. */
export function ClickUpSendGradient() {
  return <ThemedGradientFill direction="horizontal" radius={6} uniProps={sendGradientMapping} />;
}

const styles = StyleSheet.create((theme: Theme) => ({
  frame: {
    padding: FRAME_WIDTH,
    borderRadius: CLICKUP_COMPOSER_RADIUS + FRAME_WIDTH,
    backgroundColor: theme.colors.surface0,
  },
}));
