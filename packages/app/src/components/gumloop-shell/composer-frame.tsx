import type { ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { ThemedGradientFill } from "./gradient-fill";

export const GUMLOOP_COMPOSER_RADIUS = 18;
const FRAME_WIDTH = 2;

const composerGradientMapping = (theme: Theme) => ({
  colors: theme.chrome.composerGradient.join(","),
});
const sendGradientMapping = (theme: Theme) => ({ colors: theme.chrome.sendGradient.join(",") });

/** Two-pixel horizontal border. The input model and toolbar remain owned by the composer. */
export function GumloopComposerFrame({
  enabled,
  children,
  fullscreen = false,
}: {
  enabled: boolean;
  children: ReactNode;
  fullscreen?: boolean;
}) {
  if (!enabled) return children;
  return (
    <View style={[styles.frame, fullscreen && styles.fullscreen]} testID="gumloop-composer-frame">
      <ThemedGradientFill
        direction="horizontal"
        radius={GUMLOOP_COMPOSER_RADIUS + FRAME_WIDTH}
        uniProps={composerGradientMapping}
      />
      {children}
    </View>
  );
}

/** Solid primary fill, using the same theme-reactive painter as the frame. */
export function GumloopSendGradient() {
  return <ThemedGradientFill direction="horizontal" radius={16} uniProps={sendGradientMapping} />;
}

const styles = StyleSheet.create((theme: Theme) => ({
  fullscreen: { flex: 1 },
  frame: {
    padding: FRAME_WIDTH,
    borderRadius: GUMLOOP_COMPOSER_RADIUS + FRAME_WIDTH,
    backgroundColor: theme.colors.surface0,
  },
}));
