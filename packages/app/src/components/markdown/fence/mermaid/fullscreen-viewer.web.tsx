import { useCallback, useEffect, useMemo, useRef } from "react";
import { Modal, View } from "react-native";
import { X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ZoomableViewport } from "@/components/zoomable-viewport";
import { SPACING } from "@/styles/theme";
import { WindowChromeRootRegion } from "@/utils/desktop-window";
import { useGlobalWebOverlayLayer, useWebOverlayRegistration } from "@/lib/overlay-root";
import { MermaidIframeRuntime, type MermaidRenderedMessage } from "./iframe-runtime.web";
import type { DiagramColorScheme } from "./render-model";
import { useMermaidRenderModel } from "./use-render-model";

interface MermaidFullscreenViewerProps {
  source: string;
  colorScheme: DiagramColorScheme;
  onClose: () => void;
}

// The diagram is already in the render cache, so the viewport knows its size before the
// fullscreen iframe has re-rendered it.
const FALLBACK_SIZE = { width: 240, height: 240 };
const VIEWER_FIT = { padding: SPACING[6] };

export function MermaidFullscreenViewer({
  source,
  colorScheme,
  onClose,
}: MermaidFullscreenViewerProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const { state, request, rendered, renderFailed } = useMermaidRenderModel({
    source,
    phase: "complete",
    colorScheme,
  });
  const handleRendered = useCallback(
    (message: MermaidRenderedMessage) => {
      rendered({
        revision: message.revision,
        source: message.source,
        colorScheme: message.colorScheme,
        dimensions: { height: message.height, width: message.width },
      });
    },
    [rendered],
  );

  // Route Escape through the web overlay owner so dismissal takes first refusal before the
  // app-wide shortcut dispatcher (which would otherwise interrupt the running agent).
  const modalLayer = useGlobalWebOverlayLayer("modal", true);
  const handleWebOverlayKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== "Escape") return false;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return true;
    },
    [onClose],
  );
  const setWebOverlayScope = useWebOverlayRegistration({
    active: true,
    layer: modalLayer,
    onKeyDown: handleWebOverlayKeyDown,
  });

  // The Modal focus trap walks descendants and focuses the first one that takes it. Focus the
  // content layer ourselves (this effect runs after the trap's) so keystrokes stay in this
  // document instead of disappearing into a focused diagram iframe.
  const contentLayerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    contentLayerRef.current?.focus();
  }, []);

  const visible = state.visible;
  const contentSize = useMemo(
    () => (visible ? { width: visible.width, height: visible.height } : FALLBACK_SIZE),
    [visible],
  );
  const actions = useMemo(
    () => [
      {
        icon: X,
        label: t("common.actions.close"),
        onPress: onClose,
        testID: "mermaid-fullscreen-close",
      },
    ],
    [onClose, t],
  );
  const contentLayerStyle = useMemo(
    () => [
      styles.contentLayer,
      {
        paddingTop: insets.top,
        paddingRight: insets.right,
        paddingBottom: insets.bottom,
        paddingLeft: insets.left,
      },
    ],
    [insets.bottom, insets.left, insets.right, insets.top],
  );

  return (
    <Modal transparent animationType="fade" statusBarTranslucent visible onRequestClose={onClose}>
      <WindowChromeRootRegion corners="both">
        <View ref={setWebOverlayScope} style={styles.root}>
          <View style={styles.backdrop} />
          <View style={contentLayerStyle}>
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focus holder for the Escape shortcut */}
            <div ref={contentLayerRef} style={focusLayerDomStyle} tabIndex={-1}>
              <ZoomableViewport
                accessibilityLabel={t("message.diagram.diagram")}
                actions={actions}
                contentSize={contentSize}
                fit={VIEWER_FIT}
                minScale={1}
                onPressOutsideContent={onClose}
                style={styles.viewport}
                testID="mermaid-fullscreen-viewport"
                wheelActivation="always"
              >
                <MermaidIframeRuntime
                  request={request}
                  onRendered={handleRendered}
                  onRenderFailed={renderFailed}
                />
              </ZoomableViewport>
            </div>
          </View>
        </View>
      </WindowChromeRootRegion>
    </Modal>
  );
}

const focusLayerDomStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  minHeight: 0,
  outline: "none",
};

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, minHeight: 0, minWidth: 0 },
  backdrop: { position: "absolute", inset: 0, backgroundColor: theme.colors.surface0 },
  contentLayer: { position: "absolute", inset: 0 },
  viewport: { flex: 1 },
}));
