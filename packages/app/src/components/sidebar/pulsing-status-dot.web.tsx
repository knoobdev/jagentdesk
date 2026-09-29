import { useMemo } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { useRetainedPanelActive } from "@/components/retained-panel";

// Web variant of the busy dot: same pulse as the native file, driven by a CSS animation.
// Reanimated on web advances withRepeat from a JS frame loop and rewrites the dot's inline
// opacity on every frame, which kept the renderer busy for as long as any agent was running,
// including while the user was looking at another screen. A CSS opacity animation runs on the
// compositor with no JS per frame.
const PULSE_HALF_PERIOD_MS = 900;
const PULSE_MIN_OPACITY = 0.65;
const PULSE_PERIOD_MS = PULSE_HALF_PERIOD_MS * 2;
const PULSE_ANIMATION_NAME = "jagentdesk-status-dot-pulse";
const PULSE_KEYFRAME_ID = "jagentdesk-status-dot-pulse-keyframes";
const PULSE_KEYFRAME_CSS = `
  @keyframes ${PULSE_ANIMATION_NAME} {
    0% { opacity: 1; }
    100% { opacity: ${PULSE_MIN_OPACITY}; }
  }
`;

function ensurePulseKeyframes(): void {
  if (typeof document === "undefined" || document.getElementById(PULSE_KEYFRAME_ID)) {
    return;
  }
  const styleElement = document.createElement("style");
  styleElement.id = PULSE_KEYFRAME_ID;
  styleElement.textContent = PULSE_KEYFRAME_CSS;
  document.head.appendChild(styleElement);
}

// Every dot shares one clock: a negative delay places a dot at the phase the others are
// already at, so a column of dots breathes in step, as on native.
function createPulseStyle(): ViewStyle {
  ensurePulseKeyframes();
  const phaseMs = Math.round(performance.now() % PULSE_PERIOD_MS);
  return {
    animation: `${PULSE_ANIMATION_NAME} ${PULSE_HALF_PERIOD_MS}ms ease-in-out -${phaseMs}ms infinite alternate`,
  } as ViewStyle;
}

/** A status dot, breathing in step with every other one on screen. */
export function PulsingStatusDot({
  style,
  testID,
}: {
  style: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const active = useRetainedPanelActive();
  const reduceMotion = useReducedMotion();
  // Taken when the animation starts, not on every render: changing the delay of a running
  // animation shifts its phase.
  const pulseStyle = useMemo(() => (active ? createPulseStyle() : null), [active]);

  // Reduced motion leaves the dot fully opaque. It still carries the running color, and the
  // status is spelled out in the surrounding row's accessible label either way.
  return <View testID={testID} style={[style, reduceMotion ? null : pulseStyle]} />;
}
