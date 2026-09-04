import { useEffect, useMemo, useRef } from "react";
import { Animated, type DimensionValue, type StyleProp, View, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { isNative } from "@/constants/platform";
import type { Theme } from "@/styles/theme";

/**
 * A single pulse driver shared across a group of skeleton blocks so a screen full
 * of placeholders animates in unison off one loop instead of N independent ones.
 * Pass the returned value to every `<Skeleton pulse={…}>` in the same view.
 */
export function useSkeletonPulse(): Animated.Value {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1000, useNativeDriver: isNative }),
        Animated.timing(pulse, { toValue: 0, duration: 1000, useNativeDriver: isNative }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [pulse]);
  return pulse;
}

/**
 * A shimmering placeholder block sized to stand in for real content while a data
 * query is in flight. Uses the elevated surface token so it reads as "loading"
 * (not empty) in both light and dark themes. Provide a shared `pulse` (from
 * `useSkeletonPulse`) when several skeletons should breathe together; omit it for
 * a one-off block that drives its own loop.
 */
export function Skeleton({
  width,
  height = 12,
  radius,
  pulse,
  style,
}: {
  width?: DimensionValue;
  height?: DimensionValue;
  radius?: number;
  pulse?: Animated.Value;
  style?: StyleProp<ViewStyle>;
}) {
  const ownPulse = useRef(new Animated.Value(0)).current;
  const usingOwn = pulse === undefined;
  useEffect(() => {
    if (!usingOwn) return;
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(ownPulse, { toValue: 1, duration: 1000, useNativeDriver: isNative }),
        Animated.timing(ownPulse, { toValue: 0, duration: 1000, useNativeDriver: isNative }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [ownPulse, usingOwn]);

  const driver = pulse ?? ownPulse;
  const opacity = driver.interpolate({ inputRange: [0, 1], outputRange: [0.4, 0.8] });
  const animatedStyle = useMemo(
    () => [
      styles.block,
      { width, height, opacity, ...(radius !== undefined ? { borderRadius: radius } : {}) },
      style,
    ],
    [width, height, opacity, radius, style],
  );

  return <Animated.View style={animatedStyle} />;
}

/**
 * A convenience stack of full-width skeleton lines for list/detail placeholders.
 * All lines share one pulse. `lineHeight` and `gap` default to sensible row sizes.
 */
export function SkeletonLines({
  count = 4,
  lineHeight = 12,
  gap,
  style,
}: {
  count?: number;
  lineHeight?: number;
  gap?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const pulse = useSkeletonPulse();
  const keys = useMemo(
    () => Array.from({ length: count }, (_, i) => `skeleton-line-${i}`),
    [count],
  );
  const containerStyle = useMemo(
    () => [styles.lines, gap !== undefined ? { gap } : null, style],
    [gap, style],
  );
  return (
    <View style={containerStyle}>
      {keys.map((key, i) => (
        <Skeleton
          key={key}
          pulse={pulse}
          height={lineHeight}
          // Vary the last line's width so the stack reads as text, not bars.
          width={i === count - 1 ? "60%" : "100%"}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  block: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.sm,
  },
  lines: {
    gap: theme.spacing[2],
  },
}));
