import {
  AssistantFileLinkResolverProvider,
  useAssistantFileLinkEnvironment,
} from "@/assistant-file-links/provider";
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
  const environment = useAssistantFileLinkEnvironment();
  const documentPath =
    filePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(filePath)
      ? filePath
      : `${workspaceRoot ?? ""}/${filePath}`;
  const relativePathBase = documentPath.replace(/[/\\][^/\\]*$/, "");
  return (
    <View style={styles.outerGutter}>
      <View style={styles.readingFrame} testID="markdown-preview-frame">
        <AssistantFileLinkResolverProvider
          {...environment}
          client={client}
          serverId={serverId}
          workspaceRoot={workspaceRoot}
          relativePathBase={relativePathBase}
        >
          <MarkdownRenderer
            text={source}
            filePath={filePath}
            workspaceRoot={workspaceRoot}
            client={client}
            serverId={serverId}
          />
        </AssistantFileLinkResolverProvider>
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
