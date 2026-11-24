import { requireNativeView } from "expo";
import { useCallback, useMemo } from "react";
import type { StyleProp, ViewStyle } from "react-native";

import type {
  JAgentDeskTerminalCellMetrics,
  JAgentDeskTerminalFrame,
  JAgentDeskTerminalTheme,
} from "./contract";
import { encodeTerminalCustomGlyphs, type JAgentDeskTerminalCustomGlyph } from "./custom-glyphs";
import { encodeTerminalFrame, type NativeJAgentDeskTerminalFrame } from "./frame-encoding";

export * from "./contract";

export interface JAgentDeskTerminalViewProps {
  frame: JAgentDeskTerminalFrame;
  theme: JAgentDeskTerminalTheme;
  fontFamily: string;
  /** Font size in points after the system font scale is applied. */
  fontSize: number;
  onCellMetrics?: (metrics: JAgentDeskTerminalCellMetrics) => void;
  style?: StyleProp<ViewStyle>;
}

interface NativeJAgentDeskTerminalViewProps extends Omit<
  JAgentDeskTerminalViewProps,
  "frame" | "onCellMetrics"
> {
  frame: NativeJAgentDeskTerminalFrame;
  customGlyphs: JAgentDeskTerminalCustomGlyph[];
  onCellMetrics?: (event: { nativeEvent: JAgentDeskTerminalCellMetrics }) => void;
}

const NativeJAgentDeskTerminalView =
  requireNativeView<NativeJAgentDeskTerminalViewProps>("JAgentDeskTerminal");
const CUSTOM_GLYPHS = encodeTerminalCustomGlyphs();

export function JAgentDeskTerminalView({
  frame,
  onCellMetrics,
  ...props
}: JAgentDeskTerminalViewProps) {
  const nativeFrame = useMemo(() => encodeTerminalFrame(frame), [frame]);
  const handleCellMetrics = useCallback(
    (event: { nativeEvent: JAgentDeskTerminalCellMetrics }) => onCellMetrics?.(event.nativeEvent),
    [onCellMetrics],
  );
  return (
    <NativeJAgentDeskTerminalView
      {...props}
      frame={nativeFrame}
      customGlyphs={CUSTOM_GLYPHS}
      onCellMetrics={handleCellMetrics}
    />
  );
}
