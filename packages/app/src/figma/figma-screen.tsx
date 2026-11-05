import { default as React, useCallback, useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { withUnistyles } from "react-native-unistyles";
import { Figma as FigmaIcon, Link2, PenTool, Settings2 } from "lucide-react-native";
import { PageHeader } from "@/components/headers/page-header";
import { Button } from "@/components/ui/button";
import { useHostFeature } from "@/runtime/host-features";
import { useHosts } from "@/runtime/host-runtime";
import type { FigmaFile } from "@jagentdesk/protocol/figma/rpc-schemas";
import { FigmaConnectScreen } from "@/figma/connect/connect-screen";
import { FigmaLinkPanel } from "@/figma/link/link-panel";
import { useFigmaNav } from "@/figma/nav";
import { useFigmaConnections, useFigmaFiles } from "@/figma/queries";
import { EmptyState, ErrorBanner, tint, type ThemedIcon } from "@/figma/ui/primitives";
import { figmaStyles } from "@/figma/ui/styles";
import { errorMessage } from "@/figma/api";
import { FigmaFileScreen } from "@/figma/canvas/file-screen";

// The Figma section (spec 32.5): the rail opens /h/<serverId>/figma; without a fileKey this shows
// the home — connections/files, the connect guide, or the Figma Link panel per the `view` param;
// with a fileKey it mounts the W10 file screen. The left column lives in sidebar-figma-nav.

const ThemedLink2 = withUnistyles(Link2) as ThemedIcon;

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function FileCard({ file, onOpen }: { file: FigmaFile; onOpen: (fileKey: string) => void }) {
  const open = useCallback(() => onOpen(file.fileKey), [file.fileKey, onOpen]);
  return (
    <Pressable
      style={figmaStyles.card}
      onPress={open}
      accessibilityRole="button"
      testID={`figma-file-${file.fileKey}`}
    >
      <View style={figmaStyles.rowBetween}>
        <Text style={figmaStyles.rowTitle} numberOfLines={1}>
          {file.name || file.fileKey}
        </Text>
        {file.linked ? <ThemedLink2 size={14} uniProps={tint.green} /> : null}
      </View>
      <Text style={figmaStyles.rowSubtle} numberOfLines={1}>
        {[
          file.projectName,
          file.pinned ? "pinned" : null,
          file.lastOpenedAt_ms
            ? `opened ${new Date(file.lastOpenedAt_ms).toLocaleDateString()}`
            : null,
        ]
          .filter(Boolean)
          .join(" · ") || file.fileKey}
      </Text>
    </Pressable>
  );
}

function FilesHome({ serverId, connectionId }: { serverId: string; connectionId: string | null }) {
  const { go } = useFigmaNav();
  const files = useFigmaFiles(serverId, connectionId);
  const list = useMemo(() => files.data ?? [], [files.data]);
  const openFile = useCallback(
    (fileKey: string) => go({ fileKey, pageId: null, nodeId: null, version: null }),
    [go],
  );
  const openConnect = useCallback(() => go({ view: "connect" }), [go]);
  const connectAction = useMemo(
    () => (
      <Button variant="outline" onPress={openConnect} testID="figma-open-connect">
        Connect Figma
      </Button>
    ),
    [openConnect],
  );
  if (files.isLoading) return <Text style={figmaStyles.rowSubtle}>Loading files…</Text>;
  if (files.error) return <ErrorBanner message={errorMessage(files.error)} />;
  const pinned = list.filter((file) => file.pinned);
  const recent = [...list]
    .filter((file) => !file.pinned)
    .sort((a, b) => (b.lastOpenedAt_ms ?? 0) - (a.lastOpenedAt_ms ?? 0))
    .slice(0, 12);
  if (list.length === 0) {
    return (
      <EmptyState
        title="No files yet"
        body="Add a Figma file by URL from the left column, or sign in with your own OAuth app to get started."
        action={connectAction}
        testID="figma-files-empty"
      />
    );
  }
  return (
    <ScrollView
      style={figmaStyles.screen}
      contentContainerStyle={figmaStyles.scrollContent}
      testID="figma-files-home"
    >
      {pinned.length > 0 ? (
        <View style={figmaStyles.section}>
          <Text style={figmaStyles.sectionHeading}>Pinned</Text>
          {pinned.map((file) => (
            <FileCard key={file.fileKey} file={file} onOpen={openFile} />
          ))}
        </View>
      ) : null}
      {recent.length > 0 ? (
        <View style={figmaStyles.section}>
          <Text style={figmaStyles.sectionHeading}>Recent</Text>
          {recent.map((file) => (
            <FileCard key={file.fileKey} file={file} onOpen={openFile} />
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}

export function FigmaScreen() {
  const params = useLocalSearchParams<{ serverId?: string | string[] }>();
  const hosts = useHosts();
  const serverId = firstParam(params.serverId) ?? hosts[0]?.serverId ?? "";
  const supportsFigma = useHostFeature(serverId, "figma");
  const { location, go } = useFigmaNav();
  const connections = useFigmaConnections(serverId);
  const list = useMemo(() => connections.data ?? [], [connections.data]);
  const connected = list.find((connection) => connection.authState === "connected") ?? null;
  const selectedConnection =
    list.find((connection) => connection.id === location.connectionId) ?? connected;

  const openConnections = useCallback(() => go({ view: "connect" }), [go]);
  const openLink = useCallback(() => go({ view: "link" }), [go]);
  const openFiles = useCallback(() => go({ view: "files" }), [go]);
  const fileRef = useMemo(
    () =>
      location.fileKey
        ? {
            serverId,
            fileKey: location.fileKey,
            ...(location.version ? { version: location.version } : {}),
          }
        : null,
    [serverId, location.fileKey, location.version],
  );
  const headerDescription = useMemo(() => {
    if (!selectedConnection)
      return "Browse designs, prototype, and edit from your phone or desktop";
    const email = selectedConnection.account.email;
    return `${selectedConnection.account.handle}${email ? ` · ${email}` : ""}`;
  }, [selectedConnection]);

  let body = <FilesHome serverId={serverId} connectionId={selectedConnection?.id ?? null} />;
  if (!supportsFigma) {
    body = (
      <EmptyState
        title="Update the host"
        body="This host does not offer Figma yet. Update JAgentDesk on the host."
        testID="figma-no-host"
      />
    );
  } else if (location.view === "link") {
    body = <FigmaLinkPanel serverId={serverId} />;
  } else if (location.view === "connect" || (!connections.isLoading && !selectedConnection)) {
    body = <FigmaConnectScreen serverId={serverId} connections={list} onConnected={openFiles} />;
  } else if (fileRef) {
    body = <FigmaFileScreen {...fileRef} />;
  }

  return (
    <View style={figmaStyles.screen} testID="figma-screen">
      <PageHeader
        icon={FigmaIcon}
        title="Figma"
        description={headerDescription}
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              leftIcon={PenTool}
              onPress={openLink}
              testID="figma-open-link"
            >
              Figma Link
            </Button>
            <Button
              size="sm"
              variant="ghost"
              leftIcon={Settings2}
              onPress={openConnections}
              testID="figma-open-connections"
            >
              Connections
            </Button>
          </>
        }
        testID="figma-header"
      />
      {connections.error ? <ErrorBanner message={errorMessage(connections.error)} /> : null}
      {body}
    </View>
  );
}
