import {
  FloatingHeaderOverlay,
  useFloatingHeaderOverlayClearance,
} from "@/components/floating-header";
import { useIsGumloopTheme } from "@/components/gumloop-shell/use-gumloop-chrome";
import { showNativeToast } from "./native-toast";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Animated, Easing, Text, View, type LayoutChangeEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative, isWeb } from "@/constants/platform";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react-native";
import { getOverlayRoot, OVERLAY_Z } from "@/lib/overlay-root";
import {
  HEADER_INNER_HEIGHT,
  HEADER_INNER_HEIGHT_MOBILE,
  HEADER_TOP_PADDING_MOBILE,
} from "@/constants/layout";

export type ToastVariant = "default" | "info" | "success" | "warning" | "error";
/**
 * `action` tightens vertical and trailing insets around `size="sm"` pill controls and uses a
 * concentric corner radius (`controlHeight / 2 + inset`) so buttons nest evenly in the shell.
 */
export type ToastLayout = "default" | "action";

export interface ToastShowOptions {
  icon?: ReactNode;
  variant?: ToastVariant;
  layout?: ToastLayout;
  durationMs?: number | null;
  nativeAndroid?: boolean;
  testID?: string;
  /** Runs once when this toast leaves the screen: timed out, dismissed, or replaced. */
  onDismiss?: () => void;
}

export interface ToastState {
  id: number;
  content: ReactNode;
  nativeMessage: string | null;
  icon?: ReactNode;
  variant: ToastVariant;
  layout?: ToastLayout;
  durationMs: number | null;
  testID?: string;
  onDismiss?: () => void;
}

export type DismissToast = () => void;
const noopDismiss = () => {};

export interface ToastApi {
  show: (content: ReactNode, options?: ToastShowOptions) => void | DismissToast;
  copied: (label?: string) => void;
  error: (message: string) => void;
}

type ToastViewportPlacement = "app-shell" | "panel" | "sidebar";

const DEFAULT_DURATION_MS = 2200;
/** The sidebar toasts sit this far above the region's bottom edge (`sidebarContainer.bottom`). */
const SIDEBAR_TOAST_INSET = 8;

export function useToastHost(): {
  api: ToastApi;
  toast: ToastState | null;
  dismiss: () => void;
} {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const [toast, setToastState] = useState<ToastState | null>(null);
  const toastRef = useRef<ToastState | null>(null);
  const idRef = useRef(0);

  const setToast = useCallback((next: ToastState | null) => {
    const previous = toastRef.current;
    if (previous === next) return;
    toastRef.current = next;
    setToastState(next);
    previous?.onDismiss?.();
  }, []);

  const show = useCallback(
    (content: ReactNode, options?: ToastShowOptions): DismissToast => {
      const nativeMessage = typeof content === "string" ? content.trim() : null;
      if (!content || nativeMessage === "") {
        return noopDismiss;
      }

      const variant = options?.variant ?? "default";
      const durationMs =
        options?.durationMs === undefined ? DEFAULT_DURATION_MS : options.durationMs;
      const nativeAndroid = options?.nativeAndroid ?? false;

      if (nativeAndroid && nativeMessage && showNativeToast(nativeMessage, durationMs)) {
        return noopDismiss;
      }

      idRef.current += 1;
      const id = idRef.current;
      setToast({
        id,
        content,
        nativeMessage,
        icon: options?.icon,
        variant,
        layout: options?.layout,
        durationMs,
        testID: options?.testID,
        onDismiss: options?.onDismiss,
      });
      return () => {
        if (toastRef.current?.id === id) setToast(null);
      };
    },
    [setToast],
  );

  const api = useMemo<ToastApi>(
    () => ({
      show,
      copied: (label?: string) =>
        show(label ? t("common.states.copiedLabel", { label }) : t("common.states.copied"), {
          variant: "success",
          icon: <CheckCircle2 size={18} color={theme.colors.foreground} />,
        }),
      error: (message: string) => show(message, { variant: "error", durationMs: 3200 }),
    }),
    [show, theme.colors.foreground, t],
  );

  const dismiss = useCallback(() => {
    setToast(null);
  }, [setToast]);

  return { api, toast, dismiss };
}

export function ToastViewport({
  toast,
  persistentToast = null,
  onDismiss,
  placement = "app-shell",
  onBottomCoverageChange,
}: {
  toast: ToastState | null;
  /** Sidebar placement: a persistent bar (such as select mode) that stays below transient toasts. */
  persistentToast?: ToastState | null;
  onDismiss: () => void;
  placement?: ToastViewportPlacement;
  /** Sidebar placement: the distance the toasts cover above the region's bottom edge. */
  onBottomCoverageChange?: (height: number) => void;
}) {
  const gumloop = useIsGumloopTheme();
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const isMobile = useIsCompactFormFactor();
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(-8)).current;
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissDeadlineRef = useRef<number | null>(null);
  const remainingDurationRef = useRef(0);

  const clearTimer = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const animateOut = useCallback(() => {
    clearTimer();
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 0,
        duration: 140,
        easing: Easing.out(Easing.quad),
        useNativeDriver: isNative,
      }),
      Animated.timing(translateY, {
        toValue: -8,
        duration: 140,
        easing: Easing.out(Easing.quad),
        useNativeDriver: isNative,
      }),
    ]).start(({ finished }) => {
      if (finished) {
        onDismiss();
      }
    });
  }, [clearTimer, onDismiss, opacity, translateY]);

  const scheduleDismiss = useCallback(
    (durationMs: number | null) => {
      clearTimer();
      if (durationMs === null) {
        remainingDurationRef.current = 0;
        dismissDeadlineRef.current = null;
        return;
      }
      const nextDurationMs = Math.max(0, durationMs);
      remainingDurationRef.current = nextDurationMs;
      dismissDeadlineRef.current = Date.now() + nextDurationMs;
      timeoutRef.current = setTimeout(() => {
        animateOut();
      }, nextDurationMs);
    },
    [animateOut, clearTimer],
  );

  const pauseDismiss = useCallback(() => {
    if (dismissDeadlineRef.current !== null) {
      remainingDurationRef.current = Math.max(0, dismissDeadlineRef.current - Date.now());
    }
    dismissDeadlineRef.current = null;
    clearTimer();
  }, [clearTimer]);

  const resumeDismiss = useCallback(() => {
    if (!toast || toast.durationMs === null) {
      return;
    }
    scheduleDismiss(remainingDurationRef.current || toast.durationMs);
  }, [scheduleDismiss, toast]);

  useEffect(() => {
    if (!toast) {
      clearTimer();
      dismissDeadlineRef.current = null;
      remainingDurationRef.current = 0;
      opacity.setValue(0);
      translateY.setValue(-8);
      return;
    }

    clearTimer();
    opacity.setValue(0);
    translateY.setValue(-8);

    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 140,
        easing: Easing.out(Easing.quad),
        useNativeDriver: isNative,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: 140,
        easing: Easing.out(Easing.quad),
        useNativeDriver: isNative,
      }),
    ]).start();

    scheduleDismiss(toast.durationMs);

    return () => {
      clearTimer();
    };
  }, [clearTimer, opacity, scheduleDismiss, toast, translateY]);

  const panelClearance = useFloatingHeaderOverlayClearance();
  const topOffset =
    (placement === "panel" ? panelClearance : 0) +
    resolveToastTopOffset(placement, isMobile, insets.top, theme.spacing[2], theme.spacing[3]);

  const toastVariant = toast?.variant;
  const toastLayout = toast?.layout;
  const toastAnimatedStyle = useMemo(
    () => [
      ...toastSurfaceStyles(gumloop, toastVariant, toastLayout),
      {
        marginTop: placement === "sidebar" ? 0 : topOffset,
        opacity,
        transform: [{ translateY }],
      },
    ],
    [gumloop, toastLayout, toastVariant, topOffset, opacity, translateY, placement],
  );
  const toastMessageStyle = useMemo(
    () => toastMessageStyles(gumloop, toastVariant),
    [gumloop, toastVariant],
  );

  const persistentCard = renderPersistentToast(placement, persistentToast, gumloop);
  const handleSidebarLayout = onBottomCoverageChange
    ? (event: LayoutChangeEvent) => reportSidebarCoverage(event, onBottomCoverageChange)
    : undefined;

  if (!toast) {
    return renderPersistentToastOnly(persistentCard, handleSidebarLayout);
  }

  const icon = toast.icon ?? defaultToastIcon(toast.variant, theme);

  const content = (
    <View
      style={placement === "sidebar" ? styles.sidebarContainer : styles.container}
      pointerEvents="box-none"
      onLayout={placement === "sidebar" ? handleSidebarLayout : undefined}
    >
      <Animated.View
        testID={toast.testID ?? "app-toast"}
        onPointerEnter={isWeb ? pauseDismiss : undefined}
        onPointerLeave={isWeb ? resumeDismiss : undefined}
        style={toastAnimatedStyle}
        accessibilityRole="alert"
      >
        {icon ? <View style={styles.iconSlot}>{icon}</View> : null}
        {typeof toast.content === "string" ? (
          <Text testID="app-toast-message" style={toastMessageStyle}>
            {toast.content}
          </Text>
        ) : (
          <View testID="app-toast-message" style={styles.contentSlot}>
            {toast.content}
          </View>
        )}
      </Animated.View>
      {persistentCard}
    </View>
  );

  if (placement === "app-shell" && isWeb && typeof document !== "undefined") {
    return createPortal(content, getOverlayRoot());
  }

  return placement === "panel" ? <FloatingHeaderOverlay>{content}</FloatingHeaderOverlay> : content;
}

function toastSurfaceStyles(
  gumloop: boolean,
  variant: ToastVariant | undefined,
  layout: ToastLayout | undefined,
) {
  const variantStyles: Partial<Record<ToastVariant, object>> = {
    info: styles.toastInfo,
    success: styles.toastSuccess,
    warning: styles.toastWarning,
    error: styles.toastError,
  };
  const gumloopVariantStyles: Partial<Record<ToastVariant, object>> = {
    success: styles.gumloopSuccess,
    warning: styles.gumloopWarning,
    error: styles.gumloopError,
  };
  return [
    styles.toast,
    layout === "action" ? styles.toastAction : null,
    variant ? variantStyles[variant] : null,
    gumloop ? styles.gumloopToast : null,
    gumloop && variant ? gumloopVariantStyles[variant] : null,
  ];
}

function toastMessageStyles(gumloop: boolean, variant: ToastVariant | undefined) {
  const isError = variant === "error";
  return [
    styles.message,
    isError ? styles.messageError : null,
    gumloop && isError ? styles.gumloopErrorText : null,
  ];
}

function defaultToastIcon(
  variant: ToastVariant,
  theme: ReturnType<typeof useUnistyles>["theme"],
): ReactNode {
  switch (variant) {
    case "info":
      return <Info size={18} color={theme.colors.palette.blue[300]} />;
    case "success":
      return <CheckCircle2 size={18} color={theme.colors.primary} />;
    case "warning":
      return <AlertTriangle size={18} color={theme.colors.palette.amber[500]} />;
    case "error":
      return <AlertTriangle size={18} color={theme.colors.destructive} />;
    default:
      return null;
  }
}

function renderPersistentToast(
  placement: ToastViewportPlacement,
  toast: ToastState | null,
  gumloop: boolean,
): ReactNode {
  if (placement !== "sidebar" || !toast) return null;
  return <PersistentToastCard toast={toast} gumloop={gumloop} />;
}

function renderPersistentToastOnly(
  card: ReactNode,
  onLayout: ((event: LayoutChangeEvent) => void) | undefined,
): ReactNode {
  if (!card) return null;
  return (
    <View style={styles.sidebarContainer} pointerEvents="box-none" onLayout={onLayout}>
      {card}
    </View>
  );
}

/** The toasts' top edge, measured from the region's bottom: their height plus the bottom inset. */
function reportSidebarCoverage(event: LayoutChangeEvent, report: (height: number) => void) {
  const height = event.nativeEvent.layout.height;
  if (height > 0) report(height + SIDEBAR_TOAST_INSET);
}

/** The sidebar's persistent bar: no timer and no entry motion, so it reads as part of the list. */
function PersistentToastCard({ toast, gumloop }: { toast: ToastState; gumloop: boolean }) {
  const style = useMemo(
    () => [
      styles.toast,
      toast.layout === "action" ? styles.toastAction : null,
      gumloop && styles.gumloopToast,
    ],
    [gumloop, toast.layout],
  );
  return (
    <View testID={toast.testID ?? "app-toast"} style={style} accessibilityRole="alert">
      {toast.icon ? <View style={styles.iconSlot}>{toast.icon}</View> : null}
      {typeof toast.content === "string" ? (
        <Text style={styles.message}>{toast.content}</Text>
      ) : (
        <View style={styles.contentSlot}>{toast.content}</View>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    position: "absolute",
    left: theme.spacing[4],
    right: theme.spacing[4],
    top: 0,
    zIndex: OVERLAY_Z.toast,
    alignItems: "center",
  },
  sidebarContainer: {
    position: "absolute",
    left: theme.spacing[2],
    right: theme.spacing[2],
    bottom: theme.spacing[2],
    zIndex: OVERLAY_Z.toast,
    alignItems: "center",
    gap: theme.spacing[2],
  },
  toast: {
    alignSelf: "center",
    maxWidth: "92%",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius["2xl"],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    ...theme.shadow.md,
  },
  // Concentric with the 28pt size="sm" pill controls inside: radius = control height / 2 + inset.
  toastAction: {
    borderRadius: 14 + theme.spacing[1.5],
    paddingVertical: theme.spacing[1.5],
    paddingLeft: 14,
    paddingRight: theme.spacing[1.5],
  },
  gumloopToast: { borderRadius: 12 },
  gumloopSuccess: {
    backgroundColor: theme.colors.statusSuccessBackground,
    borderColor: theme.colors.statusSuccessBackground,
  },
  gumloopWarning: {
    backgroundColor: theme.colors.statusWarningBackground,
    borderColor: theme.colors.statusWarningBackground,
  },
  gumloopError: {
    backgroundColor: theme.colors.statusDangerBackground,
    borderColor: theme.colors.statusDangerBackground,
  },
  gumloopErrorText: { color: theme.colors.statusDanger },
  toastSuccess: {
    borderColor: theme.colors.border,
  },
  toastInfo: {
    borderColor: theme.colors.palette.blue[300],
  },
  toastWarning: {
    borderColor: theme.colors.palette.amber[500],
  },
  toastError: {
    borderColor: theme.colors.destructive,
  },
  iconSlot: {
    alignItems: "center",
    justifyContent: "center",
  },
  contentSlot: {
    flexShrink: 1,
    minWidth: 0,
  },
  message: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  messageError: {
    color: theme.colors.foreground,
  },
}));

function resolveToastTopOffset(
  placement: ToastViewportPlacement,
  isMobile: boolean,
  insetTop: number,
  gap: number,
  panelOffset: number,
): number {
  const headerHeight = isMobile ? HEADER_INNER_HEIGHT_MOBILE : HEADER_INNER_HEIGHT;
  const headerTopPadding = isMobile ? HEADER_TOP_PADDING_MOBILE : 0;
  return placement === "app-shell" ? insetTop + headerTopPadding + headerHeight + gap : panelOffset;
}
