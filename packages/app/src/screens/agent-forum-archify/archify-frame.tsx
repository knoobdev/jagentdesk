import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { WebView } from "react-native-webview";
import { htmlPreviewNavigationKind } from "@/file-pane/html-preview-navigation";
import { ARCHIFY_REPLAY_SCRIPT, ARCHIFY_SIZE_MESSAGE } from "./archify-document";
import { fitArchifyFrameHeight } from "./archify-frame-height";
import type { ArchifyFrameProps } from "./archify-frame-types";

// ADR-0021 §4 on iOS/Android: the same locked-down WebView as the file-pane HTML preview
// (file-pane/html-preview.tsx explains each setting). Only the document the app hands over loads;
// every later navigation is refused, storage and cache stay off, and the CSP inside the document
// blocks every fetch.
const ORIGIN_WHITELIST = ["*"];
const BASE_URL = "about:blank";

export function ArchifyFrame({ document, replayToken, height, title, testID }: ArchifyFrameProps) {
  const webViewRef = useRef<WebView | null>(null);
  const lastReplayTokenRef = useRef(replayToken);
  const source = useMemo(() => ({ html: document, baseUrl: BASE_URL }), [document]);
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const frameHeight = fitArchifyFrameHeight(contentHeight, height);
  const containerStyle = useMemo(() => ({ height: frameHeight }), [frameHeight]);
  useEffect(() => setContentHeight(null), [document]);
  const handleMessage = useCallback((event: { nativeEvent: { data: string } }) => {
    try {
      const data = JSON.parse(event.nativeEvent.data) as { type?: unknown; height?: unknown };
      if (data.type === ARCHIFY_SIZE_MESSAGE && typeof data.height === "number") {
        setContentHeight(data.height);
      }
    } catch {
      // Not a size report.
    }
  }, []);
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

  useEffect(() => {
    // Replay only on a change after mount: a (re)loaded document already plays its first pass.
    if (replayToken === lastReplayTokenRef.current) return;
    lastReplayTokenRef.current = replayToken;
    webViewRef.current?.injectJavaScript(ARCHIFY_REPLAY_SCRIPT);
  }, [replayToken]);

  return (
    <View style={containerStyle} accessibilityLabel={title}>
      <WebView
        ref={webViewRef}
        testID={testID}
        source={source}
        originWhitelist={ORIGIN_WHITELIST}
        onShouldStartLoadWithRequest={allowOnlyInitialDocument}
        onMessage={handleMessage}
        setSupportMultipleWindows={false}
        javaScriptCanOpenWindowsAutomatically={false}
        domStorageEnabled={false}
        thirdPartyCookiesEnabled={false}
        cacheEnabled={false}
        incognito
      />
    </View>
  );
}
