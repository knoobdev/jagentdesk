import { useMemo, type ComponentProps, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { GestureDetector, type GestureType } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { isWeb } from "@/constants/platform";
import { WindowChromeRootRegion } from "@/utils/desktop-window";
import { usePanelStore, type MobilePanelView } from "@/stores/panel-store";
import { getMobilePanelFrame } from "./model";
import { useIsMobilePanelPresented, useMobilePanelsRuntime } from "./provider";

type OverlayPanel = Exclude<MobilePanelView, "agent">;

interface MobilePanelOverlayProps {
  children: ReactNode;
  closeGesture: GestureType;
  panel: OverlayPanel;
  panelWidth?: number;
  scrimColor?: string;
  panelStyle?: ComponentProps<typeof Animated.View>["style"];
}

export function MobilePanelOverlay({
  children,
  closeGesture,
  panel,
  panelStyle,
  panelWidth,
  scrimColor,
}: MobilePanelOverlayProps) {
  const { position, windowWidth } = useMobilePanelsRuntime();
  const target = usePanelStore((state) => state.mobilePanel.target);
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const isOpen = target === panel;
  const isPresented = useIsMobilePanelPresented(panel);
  const isLeft = panel === "agent-list";
  const width = panelWidth ?? windowWidth;

  const sidebarAnimatedStyle = useAnimatedStyle(() => {
    const frame = getMobilePanelFrame(position.value, width);
    return {
      transform: [{ translateX: isLeft ? frame.leftTranslateX : frame.rightTranslateX }],
    };
  }, [isLeft, width]);

  const backdropAnimatedStyle = useAnimatedStyle(() => {
    const frame = getMobilePanelFrame(position.value, width);
    return { opacity: isLeft ? frame.leftBackdropOpacity : frame.rightBackdropOpacity };
  }, [isLeft, width]);

  const overlayStyle = useMemo(
    () => [
      styles.overlay,
      isWeb
        ? { display: isPresented ? ("flex" as const) : ("none" as const) }
        : { opacity: isPresented ? 1 : 0 },
    ],
    [isPresented],
  );
  const positionedPanelStyle = isLeft ? styles.leftPanel : styles.rightPanel;
  const backdropStyle = useMemo(
    () => [
      styles.backdrop,
      scrimColor ? { backgroundColor: scrimColor } : null,
      backdropAnimatedStyle,
    ],
    [backdropAnimatedStyle, scrimColor],
  );
  const combinedPanelStyle = useMemo(
    () => [styles.panel, positionedPanelStyle, { width }, panelStyle, sidebarAnimatedStyle],
    [panelStyle, positionedPanelStyle, sidebarAnimatedStyle, width],
  );
  let overlayPointerEvents: "auto" | "box-none" | "none";
  if (!isWeb) {
    overlayPointerEvents = "box-none";
  } else {
    overlayPointerEvents = isOpen ? "auto" : "none";
  }

  return (
    <GestureDetector gesture={closeGesture} touchAction="pan-y">
      {/* Fabric needs an always-mounted native host to attach the close handler while the
          retained panel content is hidden. nativeID keeps that host registered. */}
      <View
        accessibilityElementsHidden={!isOpen}
        importantForAccessibility={isOpen ? "auto" : "no-hide-descendants"}
        collapsable={false}
        nativeID={`${panel}-gesture-host`}
        pointerEvents={overlayPointerEvents}
        style={styles.overlay}
      >
        <View style={overlayStyle} pointerEvents={overlayPointerEvents}>
          <Pressable
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            onPress={showMobileAgent}
            pointerEvents={isOpen ? "auto" : "none"}
            style={StyleSheet.absoluteFill}
            testID={`${panel}-backdrop`}
          >
            <Animated.View pointerEvents="none" style={backdropStyle} />
          </Pressable>

          <Animated.View pointerEvents={isOpen ? "auto" : "none"} style={combinedPanelStyle}>
            <WindowChromeRootRegion corners="both">{children}</WindowChromeRootRegion>
          </Animated.View>
        </View>
      </View>
    </GestureDetector>
  );
}

// Reanimated owns only these static native styles and the derived transform.
// Theme values stay inline at call sites, avoiding Unistyles patching the same
// native node after Fabric commits.
const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFill,
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
  },
  panel: {
    position: "absolute",
    top: 0,
    bottom: 0,
    overflow: "hidden",
  },
  leftPanel: {
    left: 0,
  },
  rightPanel: {
    right: 0,
  },
});
