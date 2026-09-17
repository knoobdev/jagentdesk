import { useMemo } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { WebView } from "react-native-webview";
import type { ArtifactHtmlPreviewProps } from "./artifact-html-preview";

const ORIGIN_WHITELIST = ["about:*"];

// Live HTML/SVG artifact preview (native: iOS/Android host). WebView with JS enabled but no access
// to the app — untrusted agent/guest-visible content. originWhitelist "about:" keeps srcDoc-only.
export function ArtifactHtmlPreview({ html }: ArtifactHtmlPreviewProps) {
  const source = useMemo(() => ({ html }), [html]);
  return (
    <View style={styles.root}>
      <WebView
        originWhitelist={ORIGIN_WHITELIST}
        source={source}
        javaScriptEnabled
        style={styles.web}
        setSupportMultipleWindows={false}
      />
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  root: { flex: 1, backgroundColor: "#fff" },
  web: { flex: 1, backgroundColor: "#fff" },
}));
