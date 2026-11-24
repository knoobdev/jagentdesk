import {
  AssistantFileLinkResolverProvider,
  useAssistantFileLinkEnvironment,
} from "@/assistant-file-links/provider";
import { useMemo } from "react";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { ASTNode, RenderRules } from "react-native-markdown-display";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  createSharedMarkdownRules,
  MarkdownRenderer,
  type MarkdownStyles,
} from "@/components/markdown/renderer";
import { resolveMarkdownPreviewImageSource } from "./image-source";
import { FileMarkdownPreviewImage } from "./preview-image";

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
  const rules = useMemo<RenderRules>(
    () => ({
      ...createSharedMarkdownRules(),
      image: (node: ASTNode, _children, _parent: ASTNode[], _styles: MarkdownStyles) => {
        const resolved = resolveMarkdownPreviewImageSource({
          source: String(node.attributes?.src ?? ""),
          markdownPath: filePath,
          workspaceRoot,
        });
        if (!resolved) {
          return null;
        }

        return (
          <FileMarkdownPreviewImage
            key={node.key}
            source={resolved}
            occurrenceKey={`${filePath}:${node.key}`}
            alt={typeof node.attributes?.alt === "string" ? node.attributes.alt : undefined}
            client={client}
            workspaceRoot={workspaceRoot}
            serverId={serverId}
          />
        );
      },
    }),
    [client, filePath, serverId, workspaceRoot],
  );

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
          <MarkdownRenderer text={source} rules={rules} />
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
