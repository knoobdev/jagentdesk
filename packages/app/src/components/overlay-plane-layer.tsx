import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";

/** Native has no browser plane: the layer renders in place (see `overlay-plane-layer.web.tsx`). */
export function OverlayPlaneLayer({
  style,
  children,
}: {
  style: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  return (
    <View style={style} pointerEvents="box-none">
      {children}
    </View>
  );
}
