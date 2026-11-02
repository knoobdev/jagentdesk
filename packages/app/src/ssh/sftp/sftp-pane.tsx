import { useCallback, useMemo, useState } from "react";
import { FlatList, Pressable, Text, TextInput, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import {
  ArrowUp,
  Copy,
  Download,
  Eye,
  EyeOff,
  File as FileIcon,
  Folder,
  FolderPlus,
  KeyRound,
  Link2,
  MoreVertical,
  Pencil,
  RotateCw,
  Trash2,
  Upload,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { SftpEndpoint, SftpEntry, SshTransfer } from "@jagentdesk/protocol/ssh/sftp-schemas";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import { Button } from "@/components/ui/button";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import type { Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import { ErrorBanner, IconButton, Spinner, type ThemedIcon, accentTint, mutedTint } from "../ui";
import type { SftpApi } from "./api";
import {
  endpointKey,
  formatBytes,
  invalidNameReason,
  isOctalMode,
  joinEndpointPath,
  octalMode,
} from "./model";

export interface SftpPaneState {
  endpoint: SftpEndpoint;
  /** Absolute path, or "" for the endpoint's home directory. */
  path: string;
  showHidden: boolean;
}

export interface SftpEndpointOption {
  endpoint: SftpEndpoint;
  label: string;
}

export interface SftpCopyTarget {
  endpoint: SftpEndpoint;
  dir: string;
  label: string;
}

type PaneDialog =
  | { kind: "none" }
  | { kind: "actions"; entry: SftpEntry }
  | { kind: "rename"; entry: SftpEntry }
  | { kind: "chmod"; entry: SftpEntry }
  | { kind: "mkdir" };

const ThemedFolder = withUnistyles(Folder);
const ThemedFile = withUnistyles(FileIcon);
const ThemedLink = withUnistyles(Link2);
const ThemedTextInput = withUnistyles(TextInput);
const ThemedArrowUp = withUnistyles(ArrowUp);
const ThemedRotate = withUnistyles(RotateCw);
const ThemedEye = withUnistyles(Eye);
const ThemedEyeOff = withUnistyles(EyeOff);
const ThemedFolderPlus = withUnistyles(FolderPlus);
const ThemedUpload = withUnistyles(Upload);
const ThemedMore = withUnistyles(MoreVertical);
const ThemedCopy = withUnistyles(Copy);
const ThemedDownload = withUnistyles(Download);
const ThemedPencil = withUnistyles(Pencil);
const ThemedKey = withUnistyles(KeyRound);
const ThemedTrash = withUnistyles(Trash2);

const placeholderColor = (theme: Theme) => ({
  placeholderTextColor: theme.colors.foregroundExtraMuted,
});

export function sftpListQueryKey(scope: string, endpoint: SftpEndpoint) {
  return ["ssh-sftp-list", scope, endpointKey(endpoint)] as const;
}

const EMPTY_ENTRIES: SftpEntry[] = [];

export function labelForEndpoint(options: SftpEndpointOption[], endpoint: SftpEndpoint): string {
  return (
    options.find((option) => endpointKey(option.endpoint) === endpointKey(endpoint))?.label ?? ""
  );
}

function isDirectoryLike(entry: SftpEntry): boolean {
  return entry.kind === "directory" || entry.linkTargetKind === "directory";
}

function EntryIcon({ entry }: { entry: SftpEntry }) {
  if (entry.kind === "symlink" && entry.linkTargetKind !== "directory") {
    return <ThemedLink size={16} uniProps={mutedTint} />;
  }
  if (isDirectoryLike(entry)) return <ThemedFolder size={16} uniProps={accentTint} />;
  return <ThemedFile size={16} uniProps={mutedTint} />;
}

function EntryRow({
  entry,
  compact,
  onPress,
  onMore,
  moreLabel,
}: {
  entry: SftpEntry;
  compact: boolean;
  onPress: (entry: SftpEntry) => void;
  onMore: (entry: SftpEntry) => void;
  moreLabel: string;
}) {
  const handlePress = useCallback(() => onPress(entry), [entry, onPress]);
  const handleMore = useCallback(() => onMore(entry), [entry, onMore]);
  const size = isDirectoryLike(entry) ? "" : formatBytes(entry.size);
  return (
    <View style={styles.row}>
      <Pressable
        style={styles.rowMain}
        onPress={handlePress}
        onLongPress={handleMore}
        accessibilityRole="button"
        accessibilityLabel={entry.name}
        testID={`sftp-entry-${entry.name}`}
      >
        <EntryIcon entry={entry} />
        <Text style={styles.rowName} numberOfLines={1}>
          {entry.name}
        </Text>
        {compact ? null : (
          <Text style={styles.rowMeta} numberOfLines={1}>
            {entry.permissions}
          </Text>
        )}
        {compact ? null : (
          <Text style={styles.rowDate} numberOfLines={1}>
            {new Date(entry.modifiedAtMs).toLocaleString()}
          </Text>
        )}
        <Text style={styles.rowSize}>{size}</Text>
      </Pressable>
      <Pressable
        style={styles.rowMore}
        onPress={handleMore}
        accessibilityRole="button"
        accessibilityLabel={moreLabel}
      >
        <ThemedMore size={16} uniProps={mutedTint} />
      </Pressable>
    </View>
  );
}

function ActionItem({
  icon: Icon,
  label,
  onPress,
  destructive = false,
}: {
  icon: ThemedIcon;
  label: string;
  onPress: () => void;
  destructive?: boolean;
}) {
  return (
    <Pressable style={styles.actionItem} onPress={onPress} accessibilityRole="button">
      <Icon size={16} uniProps={mutedTint} />
      <Text style={destructive ? styles.actionDestructive : styles.actionLabel}>{label}</Text>
    </Pressable>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function PaneToolbar({
  endpointOptions,
  endpoint,
  onEndpointChange,
  currentPath,
  requestedPath,
  parentPath,
  showHidden,
  onNavigate,
  onRefresh,
  onToggleHidden,
  onNewFolder,
  onUpload,
  busy,
}: {
  endpointOptions: SftpEndpointOption[];
  endpoint: SftpEndpoint;
  onEndpointChange: (key: string) => void;
  currentPath: string | null;
  requestedPath: string;
  parentPath: string | null;
  showHidden: boolean;
  onNavigate: (path: string) => void;
  onRefresh: () => void;
  onToggleHidden: () => void;
  onNewFolder: () => void;
  onUpload: (() => void) | null;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const [pathDraft, setPathDraft] = useState<string | null>(null);
  const options = useMemo<SelectFieldOption<string>[]>(
    () =>
      endpointOptions.map((option) => ({
        id: endpointKey(option.endpoint),
        value: endpointKey(option.endpoint),
        label: option.label,
      })),
    [endpointOptions],
  );
  const selected = endpointOptions.find(
    (option) => endpointKey(option.endpoint) === endpointKey(endpoint),
  );
  const selectedDisplay = useMemo(() => (selected ? { label: selected.label } : null), [selected]);
  const submitPath = useCallback(() => {
    if (pathDraft === null) return;
    const next = pathDraft.trim();
    setPathDraft(null);
    if (next) onNavigate(next);
  }, [onNavigate, pathDraft]);
  const goUp = useCallback(() => {
    if (parentPath) onNavigate(parentPath);
  }, [onNavigate, parentPath]);

  return (
    <>
      <SelectField
        label={t("ssh.sftp.location")}
        value={endpointKey(endpoint)}
        selectedDisplay={selectedDisplay}
        options={options}
        onChange={onEndpointChange}
        placeholder={t("ssh.sftp.location")}
        emptyText={t("ssh.sftp.noLocations")}
        size="sm"
      />
      <View style={styles.toolbar}>
        <IconButton
          icon={ThemedArrowUp}
          label={t("ssh.sftp.up")}
          onPress={goUp}
          disabled={!parentPath}
        />
        <ThemedTextInput
          style={styles.pathInput}
          value={pathDraft ?? currentPath ?? requestedPath}
          onChangeText={setPathDraft}
          onSubmitEditing={submitPath}
          onBlur={submitPath}
          placeholder={t("ssh.sftp.pathPlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
          uniProps={placeholderColor}
          accessibilityLabel={t("ssh.sftp.pathPlaceholder")}
        />
        <IconButton icon={ThemedRotate} label={t("ssh.sftp.refresh")} onPress={onRefresh} />
        <IconButton
          icon={showHidden ? ThemedEyeOff : ThemedEye}
          label={showHidden ? t("ssh.sftp.hideHidden") : t("ssh.sftp.showHidden")}
          onPress={onToggleHidden}
        />
        <IconButton
          icon={ThemedFolderPlus}
          label={t("ssh.sftp.newFolder")}
          onPress={onNewFolder}
          disabled={currentPath === null}
        />
        {onUpload ? (
          <IconButton
            icon={ThemedUpload}
            label={t("ssh.sftp.upload")}
            onPress={onUpload}
            disabled={currentPath === null || busy}
          />
        ) : null}
      </View>
    </>
  );
}

function PaneListing({
  status,
  entries,
  error,
  compact,
  onEntryPress,
  onMore,
  onRetry,
}: {
  status: "pending" | "error" | "success";
  entries: SftpEntry[];
  error: unknown;
  compact: boolean;
  onEntryPress: (entry: SftpEntry) => void;
  onMore: (entry: SftpEntry) => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const renderItem = useCallback(
    ({ item }: { item: SftpEntry }) => (
      <EntryRow
        entry={item}
        compact={compact}
        onPress={onEntryPress}
        onMore={onMore}
        moreLabel={t("ssh.sftp.actions.more", { name: item.name })}
      />
    ),
    [compact, onEntryPress, onMore, t],
  );
  const keyExtractor = useCallback((item: SftpEntry) => item.path, []);
  if (status === "pending") {
    return (
      <View style={styles.center}>
        <Spinner />
      </View>
    );
  }
  if (status === "error") {
    return (
      <View style={styles.center}>
        <Text style={styles.centerTitle}>{t("ssh.sftp.loadFailed")}</Text>
        <Text style={styles.centerText}>{errorMessage(error)}</Text>
        <Button size="sm" variant="outline" onPress={onRetry}>
          {t("common.actions.retry")}
        </Button>
      </View>
    );
  }
  if (entries.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.centerText}>{t("ssh.sftp.empty")}</Text>
      </View>
    );
  }
  return <FlatList data={entries} renderItem={renderItem} keyExtractor={keyExtractor} />;
}

function EntryActionsSheet({
  entry,
  copyTarget,
  canDownload,
  onClose,
  onOpen,
  onCopy,
  onDownload,
  onRename,
  onChmod,
  onDelete,
}: {
  entry: SftpEntry | null;
  copyTarget: SftpCopyTarget | null;
  canDownload: boolean;
  onClose: () => void;
  onOpen: () => void;
  onCopy: () => void;
  onDownload: () => void;
  onRename: () => void;
  onChmod: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const header = useMemo<SheetHeader>(() => ({ title: entry?.name ?? "" }), [entry?.name]);
  const isFolder = entry !== null && isDirectoryLike(entry);
  return (
    <AdaptiveModalSheet visible={entry !== null} onClose={onClose} header={header}>
      <View style={styles.actions}>
        <ActionItem
          icon={isFolder ? ThemedFolder : ThemedPencil}
          label={isFolder ? t("ssh.sftp.actions.open") : t("ssh.sftp.actions.edit")}
          onPress={onOpen}
        />
        {copyTarget ? (
          <ActionItem
            icon={ThemedCopy}
            label={t("ssh.sftp.actions.copyTo", { location: copyTarget.label })}
            onPress={onCopy}
          />
        ) : null}
        {canDownload && entry?.kind === "file" ? (
          <ActionItem
            icon={ThemedDownload}
            label={t("ssh.sftp.actions.download")}
            onPress={onDownload}
          />
        ) : null}
        <ActionItem icon={ThemedPencil} label={t("ssh.sftp.actions.rename")} onPress={onRename} />
        <ActionItem icon={ThemedKey} label={t("ssh.sftp.actions.permissions")} onPress={onChmod} />
        <ActionItem
          icon={ThemedTrash}
          label={t("ssh.sftp.actions.delete")}
          onPress={onDelete}
          destructive
        />
      </View>
    </AdaptiveModalSheet>
  );
}

function usePaneValidators() {
  const { t } = useTranslation();
  const nameError = useCallback(
    (value: string) => {
      const reason = invalidNameReason(value);
      return reason ? t(`ssh.sftp.names.${reason}`) : null;
    },
    [t],
  );
  const modeError = useCallback(
    (value: string) => (isOctalMode(value.trim()) ? null : t("ssh.sftp.chmod.invalid")),
    [t],
  );
  return { nameError, modeError };
}

/**
 * One pane of the SFTP browser (spec 25.5): the daemon machine or a server. Lists a folder
 * (hidden files on demand, editable path), and creates folders, renames, chmods, deletes,
 * copies to the other pane, and downloads to the device.
 */
export function SftpPane({
  api,
  scope,
  state,
  onChange,
  endpointOptions,
  copyTarget,
  compact,
  onOpenFile,
  onDownloadToDevice,
  onUploadFromDevice,
  onTransfersQueued,
  testID,
}: {
  api: SftpApi;
  /** Cache scope for the daemon this browser talks to (its host id). */
  scope: string;
  state: SftpPaneState;
  onChange: (next: SftpPaneState) => void;
  endpointOptions: SftpEndpointOption[];
  copyTarget: SftpCopyTarget | null;
  compact: boolean;
  onOpenFile: (endpoint: SftpEndpoint, entry: SftpEntry) => void;
  onDownloadToDevice?: (endpoint: SftpEndpoint, entry: SftpEntry) => Promise<void>;
  onUploadFromDevice?: (endpoint: SftpEndpoint, dir: string) => Promise<void>;
  onTransfersQueued: (transfers: SshTransfer[]) => void;
  testID?: string;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { nameError, modeError } = usePaneValidators();
  const [dialog, setDialog] = useState<PaneDialog>({ kind: "none" });
  const [actionError, setActionError] = useState<string | null>(null);
  const listKey = useMemo(() => sftpListQueryKey(scope, state.endpoint), [scope, state.endpoint]);

  const listing = useFetchQuery({
    queryKey: [...listKey, state.path, state.showHidden],
    queryFn: () => api.list(state.endpoint, state.path, state.showHidden),
    dataShape: "list",
    staleTimeMs: 10_000,
  });
  const currentPath = listing.data?.path ?? null;
  const parentPath = listing.data?.parentPath ?? null;
  const location = labelForEndpoint(endpointOptions, state.endpoint);

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: listKey }),
    [listKey, queryClient],
  );
  const runAction = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSuccess: () => {
      setActionError(null);
      void invalidate();
    },
    onError: (error) => setActionError(errorMessage(error)),
  });

  const navigate = useCallback((path: string) => onChange({ ...state, path }), [onChange, state]);
  const closeDialog = useCallback(() => setDialog({ kind: "none" }), []);
  const handleEntryPress = useCallback(
    (entry: SftpEntry) => {
      if (isDirectoryLike(entry)) navigate(entry.path);
      else setDialog({ kind: "actions", entry });
    },
    [navigate],
  );
  const handleMore = useCallback((entry: SftpEntry) => setDialog({ kind: "actions", entry }), []);
  const handleEndpointChange = useCallback(
    (key: string) => {
      const option = endpointOptions.find((candidate) => endpointKey(candidate.endpoint) === key);
      if (option) onChange({ ...state, endpoint: option.endpoint, path: "" });
    },
    [endpointOptions, onChange, state],
  );
  const toggleHidden = useCallback(
    () => onChange({ ...state, showHidden: !state.showHidden }),
    [onChange, state],
  );
  const refresh = useCallback(() => void listing.refetch(), [listing]);
  const openMkdir = useCallback(() => setDialog({ kind: "mkdir" }), []);
  const upload = useCallback(() => {
    if (!onUploadFromDevice || currentPath === null) return;
    runAction.mutate(() => onUploadFromDevice(state.endpoint, currentPath));
  }, [currentPath, onUploadFromDevice, runAction, state.endpoint]);

  const actionsEntry = dialog.kind === "actions" ? dialog.entry : null;
  const renameEntry = dialog.kind === "rename" ? dialog.entry : null;
  const chmodEntry = dialog.kind === "chmod" ? dialog.entry : null;

  const handleOpen = useCallback(() => {
    if (!actionsEntry) return;
    closeDialog();
    if (isDirectoryLike(actionsEntry)) navigate(actionsEntry.path);
    else onOpenFile(state.endpoint, actionsEntry);
  }, [actionsEntry, closeDialog, navigate, onOpenFile, state.endpoint]);
  const handleCopy = useCallback(() => {
    if (!actionsEntry || !copyTarget) return;
    closeDialog();
    runAction.mutate(async () => {
      const transfers = await api.copy({
        source: state.endpoint,
        sourcePaths: [actionsEntry.path],
        target: copyTarget.endpoint,
        targetDir: copyTarget.dir,
      });
      onTransfersQueued(transfers);
    });
  }, [actionsEntry, api, closeDialog, copyTarget, onTransfersQueued, runAction, state.endpoint]);
  const handleDownload = useCallback(() => {
    if (!actionsEntry || !onDownloadToDevice) return;
    closeDialog();
    runAction.mutate(() => onDownloadToDevice(state.endpoint, actionsEntry));
  }, [actionsEntry, closeDialog, onDownloadToDevice, runAction, state.endpoint]);
  const handleRename = useCallback(() => {
    if (actionsEntry) setDialog({ kind: "rename", entry: actionsEntry });
  }, [actionsEntry]);
  const handleChmod = useCallback(() => {
    if (actionsEntry) setDialog({ kind: "chmod", entry: actionsEntry });
  }, [actionsEntry]);
  const handleDelete = useCallback(async () => {
    if (!actionsEntry) return;
    closeDialog();
    const confirmed = await confirmDialog({
      title: t("ssh.sftp.delete.title", { name: actionsEntry.name }),
      message: isDirectoryLike(actionsEntry)
        ? t("ssh.sftp.delete.folderMessage", { location })
        : t("ssh.sftp.delete.fileMessage", { location }),
      confirmLabel: t("ssh.sftp.delete.confirm"),
      destructive: true,
    });
    if (confirmed) runAction.mutate(() => api.remove(state.endpoint, actionsEntry.path));
  }, [actionsEntry, api, closeDialog, location, runAction, state.endpoint, t]);
  const handleDeletePress = useCallback(() => void handleDelete(), [handleDelete]);

  const submitRename = useCallback(
    async (value: string) => {
      if (!renameEntry || currentPath === null) return;
      await api.rename(
        state.endpoint,
        renameEntry.path,
        joinEndpointPath(currentPath, value.trim()),
      );
      await invalidate();
    },
    [api, currentPath, invalidate, renameEntry, state.endpoint],
  );
  const submitChmod = useCallback(
    async (value: string) => {
      if (!chmodEntry) return;
      await api.chmod(state.endpoint, chmodEntry.path, value.trim());
      await invalidate();
    },
    [api, chmodEntry, invalidate, state.endpoint],
  );
  const submitMkdir = useCallback(
    async (value: string) => {
      if (currentPath === null) return;
      await api.mkdir(state.endpoint, joinEndpointPath(currentPath, value.trim()));
      await invalidate();
    },
    [api, currentPath, invalidate, state.endpoint],
  );
  const dismissError = useCallback(() => setActionError(null), []);

  return (
    <View style={styles.pane} testID={testID}>
      <View style={styles.header}>
        <PaneToolbar
          key={`${endpointKey(state.endpoint)}:${currentPath ?? ""}`}
          endpointOptions={endpointOptions}
          endpoint={state.endpoint}
          onEndpointChange={handleEndpointChange}
          currentPath={currentPath}
          requestedPath={state.path}
          parentPath={parentPath}
          showHidden={state.showHidden}
          onNavigate={navigate}
          onRefresh={refresh}
          onToggleHidden={toggleHidden}
          onNewFolder={openMkdir}
          onUpload={onUploadFromDevice ? upload : null}
          busy={runAction.isPending}
        />
        {runAction.isPending ? (
          <View style={styles.pendingRow}>
            <Spinner />
            <Text style={styles.centerText}>{t("ssh.sftp.working")}</Text>
          </View>
        ) : null}
        {actionError ? (
          <ErrorBanner
            message={actionError}
            dismissLabel={t("common.actions.dismiss")}
            onDismiss={dismissError}
          />
        ) : null}
      </View>
      <View style={styles.body}>
        <PaneListing
          status={listing.status}
          entries={listing.data?.entries ?? EMPTY_ENTRIES}
          error={listing.error}
          compact={compact}
          onEntryPress={handleEntryPress}
          onMore={handleMore}
          onRetry={refresh}
        />
      </View>
      <EntryActionsSheet
        entry={actionsEntry}
        copyTarget={copyTarget}
        canDownload={onDownloadToDevice !== undefined}
        onClose={closeDialog}
        onOpen={handleOpen}
        onCopy={handleCopy}
        onDownload={handleDownload}
        onRename={handleRename}
        onChmod={handleChmod}
        onDelete={handleDeletePress}
      />
      <AdaptiveRenameModal
        visible={renameEntry !== null}
        title={t("ssh.sftp.rename.title")}
        initialValue={renameEntry?.name ?? ""}
        submitLabel={t("ssh.sftp.rename.submit")}
        validate={nameError}
        onClose={closeDialog}
        onSubmit={submitRename}
      />
      <AdaptiveRenameModal
        visible={chmodEntry !== null}
        title={t("ssh.sftp.chmod.title", { name: chmodEntry?.name ?? "" })}
        initialValue={chmodEntry ? octalMode(chmodEntry.mode) : ""}
        placeholder={t("ssh.sftp.chmod.placeholder")}
        submitLabel={t("ssh.sftp.chmod.submit")}
        validate={modeError}
        onClose={closeDialog}
        onSubmit={submitChmod}
      />
      <AdaptiveRenameModal
        visible={dialog.kind === "mkdir"}
        title={t("ssh.sftp.newFolder")}
        initialValue=""
        placeholder={t("ssh.sftp.folderName")}
        submitLabel={t("ssh.sftp.create")}
        validate={nameError}
        onClose={closeDialog}
        onSubmit={submitMkdir}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  pane: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    backgroundColor: theme.colors.surface0,
  },
  header: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  pathInput: {
    flex: 1,
    minWidth: 0,
    height: 28,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  pendingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  body: {
    flex: 1,
    minHeight: 0,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
  },
  centerTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  centerText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  rowMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingLeft: theme.spacing[3],
  },
  rowName: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  rowMeta: {
    width: 84,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  rowDate: {
    width: 150,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  rowSize: {
    width: 64,
    textAlign: "right",
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  rowMore: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  actions: {
    gap: theme.spacing[1],
    paddingBottom: theme.spacing[2],
  },
  actionItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
  },
  actionLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  actionDestructive: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.destructive,
  },
}));
