import { useOverlayRegistration, type KeyboardInputEvent } from "@/keyboard";
import { navigateMenuKeyboard } from "./keyboard-navigation";

import { Modal } from "@/components/ui/modal";
import type { PointerEvent } from "react-native";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactElement,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  Dimensions,
  Platform,
  Pressable,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Keyframe, runOnJS } from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";
import { FloatingScrollView, FloatingSurface } from "@/components/ui/floating";
import { isWeb } from "@/constants/platform";
import type { KeyboardFocusScope } from "@/keyboard/actions";
import { getOverlayRoot, OverlayLayerProvider, useOverlayLayer } from "@/lib/overlay-root";
import {
  computePosition,
  getTransformOrigin,
  measureElement,
  type Alignment,
  type Placement,
  type Rect,
  type Size,
} from "./menu-anchor";

const SCROLL_CONTENT_STYLE = { flexGrow: 1 } as const;
const CONTENT_ENTERING_DURATION_MS = 150;

const contentEntering = new Keyframe({
  0: { opacity: 0, transform: [{ scale: 0.97 }] },
  100: { opacity: 1, transform: [{ scale: 1 }] },
}).duration(CONTENT_ENTERING_DURATION_MS);

/** `contentEntering` for the browser's own animation engine. Both default to linear easing. */
const WEB_CONTENT_ENTERING_KEYFRAMES: PropertyIndexedKeyframes = {
  opacity: [0, 1],
  transform: ["scale(0.97)", "scale(1)"],
};

/** Web plays the same keyframes itself; see `useWebContentEntering`. */
const nativeContentEntering = isWeb ? undefined : contentEntering;

const contentExiting = new Keyframe({
  0: { opacity: 1, transform: [{ scale: 1 }] },
  100: { opacity: 0, transform: [{ scale: 0.97 }] },
}).duration(100);

/**
 * On web the surface enters through the Web Animations API rather than Reanimated. Reanimated's
 * web path snapshots an element's rect when a custom keyframe ends and, when it cleans the keyframe
 * up 750ms after the start, writes that rect back as inline top/left/width/height. A surface that
 * moved or resized in between — content that grew once its data arrived — snapped back to the old
 * rect and stayed there, clipped or hanging past its anchor. A Web Animation leaves no inline style.
 */
function useWebContentEntering({
  placed,
  surfaceNativeID,
}: {
  placed: boolean;
  surfaceNativeID: string;
}): void {
  useLayoutEffect(() => {
    if (!isWeb || !placed || typeof document === "undefined") return undefined;
    const animation = document
      .getElementById(surfaceNativeID)
      ?.animate(WEB_CONTENT_ENTERING_KEYFRAMES, CONTENT_ENTERING_DURATION_MS);
    return () => animation?.cancel();
  }, [placed, surfaceNativeID]);
}

/**
 * Keeps a surface inside one view on screen — a chat pane — rather than the whole window, so a
 * panel opened from a control in that view cannot spill over its neighbours.
 */
export interface AnchoredSurfaceBoundary {
  ref: RefObject<View | null>;
  /** Gap kept between the surface and the boundary's edges. */
  padding: number;
}

/**
 * Resolves where an anchored surface sits: measures the anchor, measures the content, and runs
 * the two through `computePosition`. Returns nulls until both measurements have landed, which is
 * why the surface renders off-screen at -9999 rather than at 0,0 on its first frame.
 */
export function useAnchoredPosition({
  open,
  anchorRect,
  anchorRef,
  side,
  align,
  offset,
  scrollable,
  maxHeight,
  boundary,
}: {
  open: boolean;
  anchorRect: Rect | null;
  anchorRef: React.RefObject<View | null>;
  side: Placement;
  align: Alignment;
  offset: number;
  scrollable: boolean;
  maxHeight?: number;
  boundary?: AnchoredSurfaceBoundary;
}) {
  const [triggerRect, setTriggerRect] = useState<Rect | null>(null);
  const [contentSize, setContentSize] = useState<Size | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [actualPlacement, setActualPlacement] = useState<Placement>(side);
  const boundaryRect = useBoundaryRect(open, boundary?.ref);

  const visibleContentSize = useMemo(() => {
    if (!contentSize) return null;
    if (!scrollable) return contentSize;

    const { height: screenHeight } = Dimensions.get("window");
    const viewportMaxHeight = Math.max(screenHeight - 16, 0);
    const resolvedMaxHeight =
      typeof maxHeight === "number" ? Math.min(maxHeight, viewportMaxHeight) : viewportMaxHeight;

    return {
      width: contentSize.width,
      height: Math.min(contentSize.height, resolvedMaxHeight),
    };
  }, [contentSize, scrollable, maxHeight]);

  useEffect(() => {
    if (!open) {
      setTriggerRect(null);
      setContentSize(null);
      setPosition(null);
      return undefined;
    }

    if (anchorRect) {
      setTriggerRect(anchorRect);
      return undefined;
    }

    if (!anchorRef.current) {
      setTriggerRect(null);
      return undefined;
    }

    let cancelled = false;

    // The app draws edge-to-edge, so measureInWindow and the full-screen Modal share one
    // coordinate space that starts at the screen top; no status bar offset applies.
    void measureElement(anchorRef.current).then((rect) => {
      if (cancelled) return undefined;
      setTriggerRect(rect);
      return undefined;
    });

    return () => {
      cancelled = true;
    };
  }, [anchorRect, anchorRef, open]);

  const boundaryPadding = boundary?.padding;
  const waitingForBoundary = boundary !== undefined && boundaryRect === null;
  useEffect(() => {
    if (!triggerRect || !visibleContentSize || waitingForBoundary) return;

    const { width: screenWidth, height: screenHeight } = Dimensions.get("window");
    // measureInWindow and Modal both use full-screen coordinates, so the display area starts at 0.
    const result = computePosition({
      triggerRect,
      contentSize: visibleContentSize,
      displayArea: boundaryRect ?? { x: 0, y: 0, width: screenWidth, height: screenHeight },
      placement: side,
      alignment: align,
      offset,
      edgePadding: boundaryRect ? boundaryPadding : undefined,
    });

    setPosition({ x: result.x, y: result.y });
    setActualPlacement(result.actualPlacement);
  }, [
    triggerRect,
    visibleContentSize,
    side,
    align,
    offset,
    boundaryRect,
    boundaryPadding,
    waitingForBoundary,
  ]);

  const onContentLayout = useCallback(
    (event: { nativeEvent: { layout: { width: number; height: number } } }) => {
      const { width, height } = event.nativeEvent.layout;
      setContentSize((current) => {
        if (current && current.width === width && current.height === height) return current;
        return { width, height };
      });
    },
    [],
  );

  return {
    position,
    actualPlacement,
    contentSize,
    visibleContentSize,
    boundaryRect,
    onContentLayout,
  };
}

/**
 * The boundary view's rect while the surface is open. A boundary that is not mounted falls back
 * to the window, so a surface never waits on a view that will not come.
 */
function useBoundaryRect(
  open: boolean,
  boundaryRef: RefObject<View | null> | undefined,
): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);
  useEffect(() => {
    if (!open || !boundaryRef) {
      setRect(null);
      return undefined;
    }
    const element = boundaryRef.current;
    if (!element) {
      const { width, height } = Dimensions.get("window");
      setRect({ x: 0, y: 0, width, height });
      return undefined;
    }
    let cancelled = false;
    void measureElement(element).then((measured) => {
      if (!cancelled) setRect(measured);
      return undefined;
    });
    return () => {
      cancelled = true;
    };
  }, [boundaryRef, open]);
  return rect;
}

export interface AnchoredSurfaceProps {
  open: boolean;
  onClose: () => void;
  onExited?: () => void;
  anchorRect: Rect | null;
  anchorRef: React.RefObject<View | null>;
  side?: Placement;
  align?: Alignment;
  offset?: number;
  width?: number;
  minWidth?: number;
  maxWidth?: number;
  maxHeight?: number;
  fullWidth?: boolean;
  horizontalPadding?: number;
  scrollable?: boolean;
  /** Keep the surface inside this view instead of the window. */
  boundary?: AnchoredSurfaceBoundary;
  /** Overrides the surface's own chrome (radius, border) for a panel that needs its own. */
  surfaceStyle?: StyleProp<ViewStyle>;
  /** A submenu sits inside its parent's overlay and must not paint a second backdrop. */
  backdrop?: boolean;
  /**
   * Hover tracking for the surface box, per docs/hover.md: plain View, pointer events, never
   * a Pressable. Web-only by nature, which is all a flyout needs.
   */
  onPointerEnter?: (event: PointerEvent) => void;
  onPointerLeave?: (event: PointerEvent) => void;
  testID?: string;
  keyboardFocusScope?: KeyboardFocusScope;
  children: ReactElement;
}

/** The width a surface may take between its boundary's padded edges; null without a boundary. */
function innerBoundaryWidth(
  rect: Rect | null,
  boundary: AnchoredSurfaceBoundary | undefined,
): number | null {
  return rect && boundary ? rect.width - boundary.padding * 2 : null;
}

/** Inside a boundary, every width the caller asked for still has to fit between its edges. */
function resolveWidthStyle({
  width,
  minWidth,
  maxWidth,
  boundaryWidth,
}: {
  width: number | undefined;
  minWidth: number | undefined;
  maxWidth: number | undefined;
  boundaryWidth: number | null;
}): ViewStyle {
  const fit = (value: number) => (boundaryWidth === null ? value : Math.min(value, boundaryWidth));
  const style: ViewStyle = {};
  if (typeof width === "number") style.width = fit(width);
  if (typeof minWidth === "number") style.minWidth = fit(minWidth);
  if (typeof maxWidth === "number") style.maxWidth = fit(maxWidth);
  else if (boundaryWidth !== null) style.maxWidth = boundaryWidth;
  return style;
}

/**
 * One floating menu surface, positioned against an anchor. The root menu renders one of these
 * against its trigger; every open submenu renders another against the row that opened it.
 */
export function AnchoredSurface({
  open,
  onClose,
  onExited,
  anchorRect,
  anchorRef,
  side = "bottom",
  align = "start",
  offset = 4,
  width,
  minWidth = 180,
  maxWidth,
  maxHeight,
  fullWidth = false,
  horizontalPadding = 16,
  scrollable = false,
  boundary,
  surfaceStyle,
  backdrop = true,
  onPointerEnter,
  onPointerLeave,
  testID,
  keyboardFocusScope,
  children,
}: AnchoredSurfaceProps): ReactElement | null {
  const { t } = useTranslation();
  const surfaceNativeID = useId();
  const { position, actualPlacement, visibleContentSize, boundaryRect, onContentLayout } =
    useAnchoredPosition({
      open,
      anchorRect,
      anchorRef,
      side,
      align,
      offset,
      scrollable,
      maxHeight,
      boundary,
    });

  // The surface is placed once both measurements land. Until then it sits off-screen so it can
  // be measured, and it must not animate: an entering animation that ran there would be over
  // before anyone saw the menu. Remounting on placement starts the native animation from the
  // final position; web starts its own animation on placement.
  const placed = position !== null;

  useWebContentEntering({ placed, surfaceNativeID });

  useEffect(() => {
    if (!isWeb || !open || !placed || typeof document === "undefined") return undefined;
    const frame = requestAnimationFrame(() => {
      document
        .getElementById(surfaceNativeID)
        ?.querySelector<HTMLElement>('[data-menu-item="true"]:not([data-menu-disabled="true"])')
        ?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, placed, surfaceNativeID]);

  const boundaryWidth = innerBoundaryWidth(boundaryRect, boundary);
  const frameStyle = useMemo<StyleProp<ViewStyle>>(() => {
    const { width: screenWidth } = Dimensions.get("window");
    const resolvedWidthStyle: ViewStyle = fullWidth
      ? { width: screenWidth - horizontalPadding * 2 }
      : resolveWidthStyle({ width, minWidth, maxWidth, boundaryWidth });
    return [
      resolvedWidthStyle,
      {
        position: "absolute" as const,
        top: position?.y ?? -9999,
        left: fullWidth ? horizontalPadding : (position?.x ?? -9999),
        transformOrigin: getTransformOrigin(actualPlacement, align),
      },
    ];
  }, [
    fullWidth,
    horizontalPadding,
    width,
    minWidth,
    maxWidth,
    position?.x,
    position?.y,
    actualPlacement,
    align,
    boundaryWidth,
  ]);

  const contentStyle = useMemo(
    () => (surfaceStyle ? [styles.content, surfaceStyle] : styles.content),
    [surfaceStyle],
  );
  const scrollViewportStyle = useMemo(
    () => [visibleContentSize ? { height: visibleContentSize.height } : null],
    [visibleContentSize],
  );
  const surfaceDataSet = useMemo(
    () => ({
      menuSurface: "true",
      ...(keyboardFocusScope ? { keyboardScope: keyboardFocusScope } : null),
    }),
    [keyboardFocusScope],
  );

  if (!open) return null;

  const measured = (
    <View
      collapsable={false}
      onLayout={onContentLayout}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      {children}
    </View>
  );

  return (
    <>
      {backdrop ? (
        <Pressable
          {...{ onContextMenu: onClose }}
          accessibilityRole="button"
          accessibilityLabel={t("menu.backdrop")}
          style={styles.backdrop}
          onPress={onClose}
          testID={testID ? `${testID}-backdrop` : undefined}
        />
      ) : null}
      <FloatingSurface
        key={placed ? "placed" : "measuring"}
        collapsable={false}
        tabIndex={-1}
        nativeID={surfaceNativeID}
        testID={testID}
        dataSet={surfaceDataSet}
        style={contentStyle}
        frameStyle={frameStyle}
        entering={placed ? nativeContentEntering : undefined}
        exiting={
          !placed || isWeb || !onExited
            ? undefined
            : contentExiting.withCallback((finished) => {
                "worklet";
                if (finished) {
                  runOnJS(onExited)();
                }
              })
        }
      >
        {scrollable ? (
          <FloatingScrollView
            bounces={false}
            showsVerticalScrollIndicator
            style={scrollViewportStyle}
            contentContainerStyle={SCROLL_CONTENT_STYLE}
          >
            {measured}
          </FloatingScrollView>
        ) : (
          measured
        )}
      </FloatingSurface>
    </>
  );
}

/**
 * The full-screen layer every floating menu surface lives in: a web portal into the overlay
 * root, or a transparent Modal on native. Submenus render inside their parent's layer rather
 * than opening another one, so there is exactly one Modal per menu no matter how deep it goes.
 */
export function MenuOverlay({
  visible,
  onClose,
  restoreFocusRef,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  restoreFocusRef?: RefObject<View | null>;
  children: ReactElement | null;
}): ReactElement | null {
  const floatingLayer = useOverlayLayer("floating");

  const handleOverlayKeyDown = useCallback(
    (event: KeyboardInputEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return true;
      }

      return navigateMenuKeyboard(event);
    },
    [onClose],
  );
  const setOverlayScope = useOverlayRegistration({
    keys: ["Escape"],
    active: visible,
    layer: floatingLayer,
    onKeyDown: handleOverlayKeyDown,
    restoreFocusRef,
  });

  if (!visible) return null;

  const overlay = (
    <OverlayLayerProvider layer={floatingLayer}>
      <View
        {...{
          onContextMenu: (event: { preventDefault?: () => void }) => event.preventDefault?.(),
        }}
        ref={setOverlayScope}
        collapsable={false}
        style={[
          styles.overlay,
          isWeb ? styles.overlayWeb : null,
          isWeb ? { zIndex: floatingLayer } : null,
        ]}
      >
        {children}
      </View>
    </OverlayLayerProvider>
  );

  if (isWeb && typeof document !== "undefined") {
    return createPortal(overlay, getOverlayRoot());
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent={Platform.OS === "android"}
      onRequestClose={onClose}
    >
      {overlay}
    </Modal>
  );
}

const styles = StyleSheet.create((theme) => ({
  overlay: {
    flex: 1,
  },
  overlayWeb: {
    ...StyleSheet.absoluteFill,
    pointerEvents: "auto" as const,
  },
  backdrop: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  content: {
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
    ...theme.shadow.md,
  },
}));
