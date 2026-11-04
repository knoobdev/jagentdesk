import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ChevronRight, FileArchive, Folder } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type {
  DaemonClient,
  SideloadHostBrowseKind,
  SideloadHostEntry,
} from "@jagentdesk/client/internal/daemon-client";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { useFetchQuery } from "@/data/query";
import type { Theme } from "@/styles/theme";
import { formatBytes, hostCrumbs, joinHostPath } from "./host-browse";
import { sideloadKey, unwrap } from "./queries";

// "Browse host…" (26.9, ADR-0032 §9): browse folders on the machine running the daemon,
// starting at the daemon's home folder. The daemon lists only sub-folders and the installable
// files of this kind (.ipa for iOS, .apk/.apks for Android); a breadcrumb goes back up and a tap
// on a file picks it. Same sheet on desktop (modal) and mobile (bottom sheet).

const SNAP_POINTS = ["85%"];
const FILE_LABEL: Record<SideloadHostBrowseKind, string> = {
  ios: ".ipa",
  android: ".apk or .apks",
};

const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const extraMuted = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });
const accent = (theme: Theme) => ({ color: theme.colors.accent });
const FolderIcon = withUnistyles(Folder, muted);
const FileIcon = withUnistyles(FileArchive, accent);
const CrumbChevron = withUnistyles(ChevronRight, extraMuted);

export function HostBrowseSheet({
  visible,
  client,
  serverId,
  kind,
  onClose,
  onPick,
}: {
  visible: boolean;
  client: DaemonClient;
  serverId: string;
  kind: SideloadHostBrowseKind;
  onClose: () => void;
  onPick: (path: string) => void;
}) {
  // null opens the daemon's home folder.
  const [folder, setFolder] = useState<string | null>(null);
  const listing = useFetchQuery({
    queryKey: sideloadKey(serverId, `host:${kind}:${folder ?? "~"}`),
    enabled: visible,
    dataShape: "value",
    staleTimeMs: 5_000,
    queryFn: async () =>
      unwrap(
        await client.sideloadCall("sideload.host.browse.request", {
          kind,
          ...(folder === null ? {} : { path: folder }),
        }),
      ),
  });
  const data = listing.data ?? null;
  const header = useMemo<SheetHeader>(
    () => ({ title: "Browse host", subtitle: `Folders and ${FILE_LABEL[kind]} files on the host` }),
    [kind],
  );
  const openEntry = useCallback(
    (entry: SideloadHostEntry) => {
      if (!data) return;
      const target = joinHostPath(data.path, entry.name);
      if (entry.kind === "directory") {
        setFolder(target);
        return;
      }
      onPick(target);
      onClose();
    },
    [data, onClose, onPick],
  );
  const files = data?.entries.filter((entry) => entry.kind === "file").length ?? 0;

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      header={header}
      desktopMaxWidth={640}
      snapPoints={SNAP_POINTS}
      testID="sideload-host-browse"
    >
      <View style={styles.body}>
        {data ? <Breadcrumb path={data.path} onNavigate={setFolder} /> : null}
        {listing.isPending ? <Text style={styles.muted}>Opening the folder…</Text> : null}
        {listing.error ? (
          <Text style={styles.error}>
            {listing.error instanceof Error ? listing.error.message : String(listing.error)}
          </Text>
        ) : null}
        {data ? (
          <View style={styles.list}>
            {data.entries.map((entry) => (
              <EntryRow key={`${entry.kind}:${entry.name}`} entry={entry} onOpen={openEntry} />
            ))}
            {data.entries.length === 0 ? (
              <Text style={styles.empty}>No folders or {FILE_LABEL[kind]} files here.</Text>
            ) : null}
          </View>
        ) : null}
        {data && data.entries.length > 0 && files === 0 ? (
          <Text style={styles.muted}>No {FILE_LABEL[kind]} files in this folder.</Text>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

function Crumb({
  label,
  path,
  isLast,
  onNavigate,
}: {
  label: string;
  path: string;
  isLast: boolean;
  onNavigate: (path: string) => void;
}) {
  const press = useCallback(() => onNavigate(path), [onNavigate, path]);
  return (
    <View style={styles.crumbWrap}>
      <Pressable onPress={press} disabled={isLast} accessibilityRole="button">
        <Text style={isLast ? styles.crumbActive : styles.crumb} numberOfLines={1}>
          {label}
        </Text>
      </Pressable>
      {isLast ? null : <CrumbChevron size={12} />}
    </View>
  );
}

function Breadcrumb({ path, onNavigate }: { path: string; onNavigate: (path: string) => void }) {
  const crumbs = useMemo(() => hostCrumbs(path), [path]);
  return (
    <View style={styles.breadcrumb} testID="sideload-host-browse-crumbs">
      {crumbs.map((crumb, index) => (
        <Crumb
          key={crumb.path}
          label={crumb.label}
          path={crumb.path}
          isLast={index === crumbs.length - 1}
          onNavigate={onNavigate}
        />
      ))}
    </View>
  );
}

function EntryRow({
  entry,
  onOpen,
}: {
  entry: SideloadHostEntry;
  onOpen: (entry: SideloadHostEntry) => void;
}) {
  const press = useCallback(() => onOpen(entry), [entry, onOpen]);
  const isFile = entry.kind === "file";
  return (
    <Pressable
      onPress={press}
      style={styles.row}
      accessibilityRole="button"
      accessibilityLabel={isFile ? `Choose ${entry.name}` : `Open ${entry.name}`}
      testID={`sideload-host-entry-${entry.name}`}
    >
      {isFile ? <FileIcon size={16} /> : <FolderIcon size={16} />}
      <Text style={isFile ? styles.fileName : styles.name} numberOfLines={1}>
        {entry.name}
      </Text>
      {isFile && entry.size !== undefined ? (
        <Text style={styles.size}>{formatBytes(entry.size)}</Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  body: { gap: theme.spacing[3], paddingBottom: theme.spacing[4] },
  breadcrumb: { flexDirection: "row", alignItems: "center", flexWrap: "wrap" },
  crumbWrap: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  crumb: {
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.accent,
    marginRight: theme.spacing[1],
  },
  crumbActive: {
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  list: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  name: { flex: 1, minWidth: 0, fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  fileName: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  size: {
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundMuted,
  },
  muted: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  empty: {
    padding: theme.spacing[3],
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  error: { fontSize: theme.fontSize.sm, color: theme.colors.destructive },
}));
