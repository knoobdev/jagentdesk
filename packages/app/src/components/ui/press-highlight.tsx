import { forwardRef } from "react";
import { Pressable, type View } from "react-native";
import { type PressHighlightProps } from "./press-highlight.types";

export const PressHighlight = forwardRef<View, PressHighlightProps>(function PressHighlight(
  { highlightStyle: _highlightStyle, ...props },
  ref,
) {
  return <Pressable ref={ref} {...props} />;
});
