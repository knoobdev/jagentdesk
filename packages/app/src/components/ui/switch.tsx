import { useCallback, useMemo, type KeyboardEvent } from "react";
import {
  Pressable,
  type GestureResponderEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated, {
  Easing,
  interpolateColor,
  useAnimatedStyle,
  useDerivedValue,
  withTiming,
} from "react-native-reanimated";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { createControlGeometry, switchGeometry } from "@/components/ui/control-geometry";
import type { Theme } from "@/styles/theme";
import { isWeb } from "@/constants/platform";

interface SwitchProps {
  value: boolean;
  onValueChange?: (value: boolean) => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

const TIMING = { duration: 180, easing: Easing.inOut(Easing.ease) };

interface SwitchTrackProps {
  value: boolean;
  trackWidth: number;
  trackHeight: number;
  thumbSize: number;
  trackOffColor: string;
  trackOnColor: string;
  thumbOffColor: string;
  thumbOnColor: string;
}

function SwitchTrack({
  value,
  trackWidth,
  trackHeight,
  thumbSize,
  trackOffColor,
  trackOnColor,
  thumbOffColor,
  thumbOnColor,
}: SwitchTrackProps) {
  const progress = useDerivedValue(() => withTiming(value ? 1 : 0, TIMING));

  const trackAnimatedStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(progress.value, [0, 1], [trackOffColor, trackOnColor]),
  }));

  const thumbAnimatedStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(progress.value, [0, 1], [thumbOffColor, thumbOnColor]),
    transform: [{ translateX: progress.value * (trackWidth - trackHeight) }],
  }));

  const trackStyle = useMemo(
    () => [
      styles.switchTrack,
      {
        width: trackWidth,
        height: trackHeight,
        borderRadius: trackHeight / 2,
        padding: (trackHeight - thumbSize) / 2,
      },
      trackAnimatedStyle,
    ],
    [trackAnimatedStyle, trackWidth, trackHeight, thumbSize],
  );
  const thumbStyle = useMemo(
    () => [
      styles.switchThumb,
      { width: thumbSize, height: thumbSize, borderRadius: thumbSize / 2 },
      styles.thumb,
      thumbAnimatedStyle,
    ],
    [thumbAnimatedStyle, thumbSize],
  );

  return (
    <Animated.View style={trackStyle}>
      <Animated.View style={thumbStyle} />
    </Animated.View>
  );
}

const ThemedSwitchTrack = withUnistyles(SwitchTrack, (theme: Theme) => ({
  trackWidth: theme.chrome.switchWidth,
  trackHeight: theme.chrome.switchHeight,
  thumbSize: theme.chrome.switchThumbSize,
  trackOffColor: theme.colors.surface3,
  trackOnColor: theme.colors.switchOn,
  thumbOffColor: theme.colors.palette.white,
  thumbOnColor: theme.colors.accentForeground,
}));

export function Switch({
  value,
  onValueChange,
  disabled = false,
  accessibilityLabel,
  testID,
  style,
}: SwitchProps) {
  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      if (disabled) return;
      onValueChange?.(!value);
    },
    [disabled, onValueChange, value],
  );

  const accessibilityState = useMemo(() => ({ checked: value, disabled }), [value, disabled]);
  // React Native Web handles Enter for a switch, but only handles Space for button roles.
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      if (!disabled && !event.repeat) onValueChange?.(!value);
    },
    [disabled, onValueChange, value],
  );
  const pressableStyle = useMemo(
    () => [styles.switchControl, disabled ? styles.disabled : null, style],
    [disabled, style],
  );

  return (
    <Pressable
      {...(isWeb ? { onKeyDown: handleKeyDown } : {})}
      onPress={handlePress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="switch"
      accessibilityState={accessibilityState}
      accessibilityLabel={accessibilityLabel}
      aria-checked={value}
      testID={testID}
      style={pressableStyle}
    >
      <ThemedSwitchTrack value={value} />
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => {
  const geometry = createControlGeometry(theme);

  return {
    switchControl: {
      ...geometry.switchControl,
    },
    switchTrack: {
      width: switchGeometry.trackWidth,
      height: switchGeometry.trackHeight,
      borderRadius: switchGeometry.trackHeight / 2,
      padding: (switchGeometry.trackHeight - switchGeometry.thumbSize) / 2,
      justifyContent: "center",
    },
    switchThumb: {
      width: switchGeometry.thumbSize,
      height: switchGeometry.thumbSize,
      borderRadius: switchGeometry.thumbSize / 2,
    },
    thumb: {
      shadowColor: "rgba(0, 0, 0, 0.25)",
      shadowOffset: { width: 0, height: 1 },
      shadowRadius: 2,
      shadowOpacity: 1,
      elevation: 2,
    },
    disabled: {
      opacity: theme.opacity[50],
    },
  };
});
