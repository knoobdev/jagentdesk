import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef } from "react";
import { View } from "react-native";
import { WebView } from "react-native-webview";
import { htmlPreviewNavigationKind } from "@/file-pane/html-preview-navigation";
import type {
  ActivityGraphFrameHandle,
  ActivityGraphFrameProps,
} from "./activity-graph-frame-types";
import { acceptSelectMessage } from "./activity-graph-target";

// ADR-0021 §4 on iOS/Android: the same locked-down WebView as the Team-mode diagram (only the
// handed-over document loads, storage/cache off, incognito); the CSP blocks every fetch. Statuses
// and camera commands are injected; the only message read back is `jad-archify-select` (31.6).
const ORIGIN_WHITELIST = ["*"];
const BASE_URL = "about:blank";
const CONTAINER_STYLE = { flex: 1 } as const;

export const ActivityGraphFrame = forwardRef<ActivityGraphFrameHandle, ActivityGraphFrameProps>(
  function ActivityGraphFrame({ document, nodeIndex, onSelect, onLoad, title, testID }, ref) {
    const webViewRef = useRef<WebView | null>(null);
    const source = useMemo(() => ({ html: document, baseUrl: BASE_URL }), [document]);
    const nodeIndexRef = useRef(nodeIndex);
    nodeIndexRef.current = nodeIndex;

    useImperativeHandle(
      ref,
      () => ({
        postStatus(nodes) {
          webViewRef.current?.injectJavaScript(
            `window.__jadActivity&&window.__jadActivity.status(${JSON.stringify(nodes)});true;`,
          );
        },
        view(action, nodeId) {
          webViewRef.current?.injectJavaScript(
            `window.__jadActivity&&window.__jadActivity.view(${JSON.stringify(action)},${JSON.stringify(nodeId ?? null)});true;`,
          );
        },
      }),
      [],
    );

    const handleMessage = useCallback(
      (event: { nativeEvent: { data: string } }) => {
        let data: unknown;
        try {
          data = JSON.parse(event.nativeEvent.data);
        } catch {
          return;
        }
        const nodeId = acceptSelectMessage(data, nodeIndexRef.current);
        if (nodeId) onSelect(nodeId);
      },
      [onSelect],
    );

    const loadedDocumentRef = useRef<string | null>(null);
    const allowOnlyInitialDocument = useCallback(
      ({ url }: { url: string }) => {
        const navigationKind = htmlPreviewNavigationKind(url);
        if (navigationKind === "fragment") return true;
        if (navigationKind === "blocked") return false;
        if (loadedDocumentRef.current === document) return false;
        loadedDocumentRef.current = document;
        return true;
      },
      [document],
    );

    return (
      <View style={CONTAINER_STYLE} accessibilityLabel={title}>
        <WebView
          ref={webViewRef}
          testID={testID}
          source={source}
          originWhitelist={ORIGIN_WHITELIST}
          onShouldStartLoadWithRequest={allowOnlyInitialDocument}
          onMessage={handleMessage}
          onLoadEnd={onLoad}
          setSupportMultipleWindows={false}
          javaScriptCanOpenWindowsAutomatically={false}
          domStorageEnabled={false}
          thirdPartyCookiesEnabled={false}
          cacheEnabled={false}
          incognito
          // Pinch zoom is handled inside the document (two-finger touch), so the page itself stays
          // at 1:1 and the archify canvas scrolls natively.
          scalesPageToFit={false}
          bounces={false}
        />
      </View>
    );
  },
);
