import { default as React, useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { withUnistyles } from "react-native-unistyles";
import { Figma as FigmaIcon, Link2, Settings2 } from "lucide-react-native";
import { PageHeader } from "@/components/headers/page-header";
import { Button } from "@/components/ui/button";
import { useHostFeature } from "@/runtime/host-features";
import { useHosts } from "@/runtime/host-runtime";
import type { FigmaFile } from "@jagentdesk/protocol/figma/rpc-schemas";
import { FigmaConnectScreen } from "@/figma/connect/connect-screen";
import { FigmaLinkPanel } from "@/figma/link/link-panel";
import { useFigmaNav } from "@/figma/nav";
import { fileSubtitle } from "@/figma/file-subtitle";
import { filterSavedFigmaFiles } from "@/figma/file-browser-model";
import { useFigmaConnections, useFigmaFiles } from "@/figma/queries";
import { EmptyState, ErrorBanner, Input } from "@/figma/ui/primitives";
import { figmaStyles } from "@/figma/ui/styles";
import type { Theme } from "@/styles/theme";
import { errorMessage } from "@/figma/api";
import { FigmaFileScreen } from "@/figma/canvas/file-screen";

// The Figma section (spec 32.5): the rail opens /h/<serverId>/figma; without a fileKey this shows
// the home — connections/files, the connect guide, or the Figma Link panel per the `view` param;
// with a fileKey it mounts the W10 file screen. The left column lives in sidebar-figma-nav.
// Figma Link is setup for the plugin integration, not a condition for viewing or playback (32.1),
// so it is reached from the sidebar's explicit Figma Link row, never from this header.

// The color lives in the mappings so no `uniProps` prop reaches the DOM node on web.
const ThemedLink2 = withUnistyles(Link2, (theme: Theme) => ({ color: theme.colors.statusSuccess }));

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function FileCard({ file, onOpen }: { file: FigmaFile; onOpen: (fileKey: string) => void }) {
  const open = useCallback(() => onOpen(file.fileKey), [file.fileKey, onOpen]);
  const subtitle = fileSubtitle(file);
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
        {file.linked ? <ThemedLink2 size={14} /> : null}
      </View>
      {subtitle ? (
        <Text style={figmaStyles.rowSubtle} numberOfLines={1}>
          {subtitle}
        </Text>
      ) : null}
    </Pressable>
  );
}

function FilesHome({ serverId, connectionId }: { serverId: string; connectionId: string | null }) {
  const { go } = useFigmaNav();
  const files = useFigmaFiles(serverId, connectionId);
  const { refetch } = files;
  const [search, setSearch] = useState("");
  const list = useMemo(() => filterSavedFigmaFiles(files.data ?? [], search), [files.data, search]);
  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);
  const openFile = useCallback(
    (fileKey: string) => go({ fileKey, pageId: null, nodeId: null, version: null }),
    [go],
  );
  const pinned = list.filter((file) => file.pinned);
  const recent = [...list]
    .filter((file) => !file.pinned)
    .sort((a, b) => (b.lastOpenedAt_ms ?? 0) - (a.lastOpenedAt_ms ?? 0));
  return (
    <ScrollView
      style={figmaStyles.screen}
      contentContainerStyle={figmaStyles.scrollContent}
      testID="figma-files-home"
    >
      <View style={figmaStyles.rowBetween}>
        <Text style={figmaStyles.sectionHeading}>Files added to JAgentDesk</Text>
        <Button
          size="sm"
          variant="ghost"
          onPress={refresh}
          disabled={files.isFetching}
          testID="figma-files-refresh"
        >
          Refresh
        </Button>
      </View>
      <Input
        value={search}
        onChangeText={setSearch}
        accessibilityLabel="Search files"
        placeholder="Search files by name"
        testID="figma-files-search"
      />
      {files.isLoading ? <Text style={figmaStyles.rowSubtle}>Loading files…</Text> : null}
      {files.error ? <ErrorBanner message={errorMessage(files.error)} /> : null}
      {!files.isLoading && !files.error && list.length === 0 ? (
        <EmptyState
          title={search.trim() ? "No matching files" : "No files added yet"}
          body={
            search.trim()
              ? "No added file matches this search."
              : "This account has no files added to JAgentDesk. This list does not include every file in your Figma account."
          }
          testID="figma-files-empty"
        />
      ) : null}
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
  // A route param can name a connection that has since lost its session; only a
  // CONNECTED account may carry the files home, otherwise the connect guide wins.
  const routeSelected = list.find((connection) => connection.id === location.connectionId) ?? null;
  const selectedConnection = routeSelected?.authState === "connected" ? routeSelected : connected;

  const openConnections = useCallback(() => go({ view: "connect" }), [go]);
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

  let body = (
    <FilesHome
      key={selectedConnection?.id ?? "none"}
      serverId={serverId}
      connectionId={selectedConnection?.id ?? null}
    />
  );
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
            {location.view === "link" ? (
              <Button size="sm" variant="ghost" onPress={openFiles} testID="figma-back-to-files">
                Files
              </Button>
            ) : null}
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
