import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ScrollView } from "@/components/ui/scroll-view";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import type { VersionsPanelProps } from "@/figma/contracts";
import type { FigmaVersion } from "@jagentdesk/protocol/figma/rpc-schemas";

import { callFigma, errorMessage, figmaKeys } from "@/figma/prototype/figma-api";
import { formatRelativeTime, versionTitle } from "./versions-model";

// Versions panel (spec 32.5.4): the file's named versions, newest first; tapping one opens the
// canvas in a read-only view of that version via onOpenVersion. While such a view is open the
// panel shows a banner with a way back to the live file.

const styles = StyleSheet.create((theme: Theme) => ({
  screen: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 },
  header: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[1],
  },
  title: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    marginHorizontal: theme.spacing[4],
    marginBottom: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  bannerText: { flex: 1, fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  body: { flex: 1, minHeight: 0, paddingHorizontal: theme.spacing[4] },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  rowMain: { flex: 1, minWidth: 0, gap: 2 },
  rowLabel: { fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  rowLabelActive: { color: theme.colors.accent },
  rowMeta: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  avatar: {
    width: 20,
    height: 20,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surfaceWorkspace,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", gap: theme.spacing[3] },
  centerSmall: { alignItems: "center", paddingVertical: theme.spacing[6], gap: theme.spacing[3] },
  muted: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  spinner: { color: theme.colors.foregroundMuted },
}));

export function VersionsPanel({ file, onOpenVersion }: VersionsPanelProps) {
  const client = useHostRuntimeClient(file.serverId);
  const versionsRequest = useFetchQuery<FigmaVersion[]>({
    queryKey: figmaKeys.versions(file.serverId, file.fileKey),
    queryFn: async () => {
      const data = await callFigma(client, "figma.file.versions.request", {
        fileKey: file.fileKey,
      });
      return data.versions;
    },
    enabled: client !== null,
    dataShape: "list",
    staleTimeMs: 60_000,
  });

  const now_ms = Date.now();
  const versions = useMemo(() => versionsRequest.data ?? [], [versionsRequest.data]);
  const retry = useCallback(() => {
    void versionsRequest.refetch();
  }, [versionsRequest]);

  if (versionsRequest.error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>{errorMessage(versionsRequest.error)}</Text>
        <Button variant="outline" size="sm" onPress={retry}>
          Retry
        </Button>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>Version history</Text>
        {file.version ? (
          <View style={styles.banner}>
            <Text style={styles.bannerText} numberOfLines={1}>
              Read-only view of an older version.
            </Text>
            <Button variant="ghost" size="xs" onPress={openLatest(onOpenVersion)}>
              Back to latest
            </Button>
          </View>
        ) : null}
      </View>
      <VersionsList
        versions={versions}
        activeVersion={file.version ?? null}
        now_ms={now_ms}
        pending={versionsRequest.isPending}
        onOpenVersion={onOpenVersion}
      />
    </View>
  );
}

function openLatest(onOpenVersion: VersionsPanelProps["onOpenVersion"]): () => void {
  return () => onOpenVersion(null);
}

interface VersionsListProps {
  versions: readonly FigmaVersion[];
  activeVersion: string | null;
  now_ms: number;
  pending: boolean;
  onOpenVersion: (version: string | null) => void;
}

function VersionsList({
  versions,
  activeVersion,
  now_ms,
  pending,
  onOpenVersion,
}: VersionsListProps) {
  if (pending) {
    return (
      <View style={styles.centerSmall}>
        <LoadingSpinner size="small" color={styles.spinner.color} />
      </View>
    );
  }
  if (versions.length === 0) {
    return (
      <View style={styles.centerSmall}>
        <Text style={styles.muted}>No named versions yet.</Text>
      </View>
    );
  }
  return (
    <ScrollView style={styles.body} testID="figma-versions-list">
      {versions.map((version) => (
        <VersionRow
          key={version.id}
          version={version}
          active={activeVersion === version.id}
          now_ms={now_ms}
          onOpenVersion={onOpenVersion}
        />
      ))}
    </ScrollView>
  );
}

function VersionRow({
  version,
  active,
  now_ms,
  onOpenVersion,
}: {
  version: FigmaVersion;
  active: boolean;
  now_ms: number;
  onOpenVersion: (version: string | null) => void;
}) {
  const open = useCallback(() => onOpenVersion(version.id), [onOpenVersion, version]);
  const handle = version.user?.handle ?? "?";
  return (
    <Pressable style={styles.row} onPress={open} accessibilityRole="button">
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>{handle.slice(0, 1).toUpperCase()}</Text>
      </View>
      <View style={styles.rowMain}>
        <Text style={[styles.rowLabel, active && styles.rowLabelActive]} numberOfLines={1}>
          {versionTitle(version, now_ms)}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {version.user ? `${version.user.handle} · ` : ""}
          {formatRelativeTime(version.createdAt_ms, now_ms)}
        </Text>
      </View>
    </Pressable>
  );
}
