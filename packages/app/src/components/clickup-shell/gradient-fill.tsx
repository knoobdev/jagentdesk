import { useId, useMemo } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

type GradientDirection = "vertical" | "horizontal" | "diagonal-up";

const DIRECTIONS: Record<GradientDirection, { x1: string; y1: string; x2: string; y2: string }> = {
  vertical: { x1: "0", y1: "0", x2: "0", y2: "1" },
  horizontal: { x1: "0", y1: "0", x2: "1", y2: "0" },
  // Bottom-left to top-right, the direction of ClickUp's Brain composer border.
  "diagonal-up": { x1: "0", y1: "1", x2: "1", y2: "0" },
};

/**
 * Paints a linear gradient behind its siblings (absolute fill). react-native-svg renders on web and
 * native alike, so the same component serves desktop and phones. A single color paints a solid fill.
 */
export function GradientFill({
  colors: colorList = "",
  direction = "vertical",
  radius = 0,
  style,
}: {
  /** Comma-separated stops ("#a,#b,#c"); a string survives withUnistyles prop mapping intact. */
  colors?: string;
  direction?: GradientDirection;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const colors = useMemo(() => colorList.split(",").filter(Boolean), [colorList]);
  const rawId = useId();
  const id = `gradient-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const solidStyle = useMemo(
    () => [StyleSheet.absoluteFill, { backgroundColor: colors[0], borderRadius: radius }, style],
    [colors, radius, style],
  );
  const svgStyle = useMemo(() => [StyleSheet.absoluteFill, style], [style]);
  if (colors.length < 2) {
    return <View pointerEvents="none" style={solidStyle} />;
  }
  const vector = DIRECTIONS[direction];
  const stops = colors.map((color, position) => ({
    key: `${position}:${color}`,
    offset: position / (colors.length - 1),
    color,
  }));
  return (
    <View pointerEvents="none" style={svgStyle}>
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id={id} {...vector}>
            {stops.map((stop) => (
              <Stop key={stop.key} offset={stop.offset} stopColor={stop.color} />
            ))}
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" rx={radius} ry={radius} fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}

/** Theme-reactive gradient: pass a `uniProps` mapping that returns `{ colors: "#a,#b" }`. */
export const ThemedGradientFill = withUnistyles(GradientFill);
