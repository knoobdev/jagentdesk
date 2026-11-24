import { MarkdownRenderer } from "@/components/markdown/renderer";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

export function FileMarkdownPreview({
  source,
  filePath,
  workspaceRoot,
  client,
  serverId,
}: {
  source: string;
  filePath: string;
  workspaceRoot?: string;
  client?: DaemonClient | null;
  serverId?: string;
}) {
  return (
    <View style={styles.outerGutter}>
      <View style={styles.readingFrame} testID="markdown-preview-frame">
        <MarkdownRenderer
          text={source}
          filePath={filePath}
          workspaceRoot={workspaceRoot}
          client={client}
          serverId={serverId}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  outerGutter: {
    width: "100%",
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[4],
    },
    paddingVertical: theme.spacing[4],
  },
  readingFrame: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[2],
  },
}));
