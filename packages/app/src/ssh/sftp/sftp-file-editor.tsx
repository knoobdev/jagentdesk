import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useFetchQuery } from "@/data/query";
import { X } from "lucide-react-native";
import { StyleSheet, UnistylesRuntime, withUnistyles } from "react-native-unistyles";
import type { SftpEndpoint, SftpOpenedFile } from "@jagentdesk/protocol/ssh/sftp-schemas";
import { Button } from "@/components/ui/button";
import { FileConflictAlert, type FileConflictAlertState } from "@/file-pane/conflict-alert";
import { FileEditorModel, getFileConflictCallout } from "@/file-pane/editor/model";
import { FileEditorView } from "@/file-pane/editor/view";
import { IconButton, Spinner } from "../ui";
import type { SftpApi } from "./api";
import {
  createSftpEditorSession,
  createSftpObservationSource,
  toEditorFile,
} from "./editor-session";
import { basename, endpointKey } from "./model";

const ThemedX = withUnistyles(X);
const noopCursor = (_position: { line: number; column: number }): void => {};
const noopVimMode = (_mode: string | null): void => {};

function EditorBody({
  api,
  endpoint,
  path,
  opened,
}: {
  api: SftpApi;
  endpoint: SftpEndpoint;
  path: string;
  opened: SftpOpenedFile;
}) {
  const { t } = useTranslation();
  const theme = UnistylesRuntime.getTheme();
  const target = useMemo(() => ({ api, endpoint, path }), [api, endpoint, path]);
  const [model] = useState(
    () =>
      new FileEditorModel({
        file: toEditorFile(endpoint, opened),
        session: createSftpEditorSession(target),
      }),
  );
  useEffect(() => {
    model.connectFileObservations(createSftpObservationSource(target, opened));
    return () => model.disconnectFileObservations();
  }, [model, opened, target]);
  useEffect(() => () => model.dispose(), [model]);
  const snapshot = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);

  const location = useMemo(() => ({ path }), [path]);
  const visualTheme = useMemo(
    () => ({
      background: theme.colors.surface0,
      foreground: theme.colors.foreground,
      foregroundMuted: theme.colors.foregroundMuted,
      border: theme.colors.border,
      cursor: theme.colors.terminal.cursor,
      selection: theme.colors.terminal.selectionBackground,
      monoFont: theme.fontFamily.mono,
      codeFontSize: theme.fontSize.code,
      syntax: theme.colors.syntax,
    }),
    [theme],
  );
  const handleReload = useCallback(() => void model.reload(), [model]);
  const handleOverwrite = useCallback(() => void model.overwrite(), [model]);
  const callout = getFileConflictCallout(snapshot);
  let conflict: FileConflictAlertState | null = null;
  if (callout?.kind === "changed") {
    conflict = {
      kind: "changed",
      canOverwrite: callout.canOverwrite,
      onReload: handleReload,
      onOverwrite: handleOverwrite,
    };
  } else if (callout?.kind === "deleted") {
    conflict = { kind: "deleted" };
  } else if (callout?.kind === "checkFailed") {
    conflict = { kind: "checkFailed", retrying: false, onRetry: handleReload };
  }

  let status: string | null = null;
  if (snapshot.status === "saving") status = t("panels.file.editor.saving");
  else if (snapshot.status === "dirty") status = t("panels.file.editor.unsavedChanges");
  else if (snapshot.status === "error") status = snapshot.error;

  return (
    <View style={styles.flex}>
      {status ? (
        <View style={styles.statusRow}>
          <Text style={snapshot.status === "error" ? styles.statusError : styles.statusText}>
            {status}
          </Text>
        </View>
      ) : null}
      {conflict ? <FileConflictAlert state={conflict} /> : null}
      <FileEditorView
        model={model}
        filename={basename(path)}
        location={location}
        navigationRevision={0}
        vimEnabled={false}
        theme={visualTheme}
        onCursorChange={noopCursor}
        onVimModeChange={noopVimMode}
      />
    </View>
  );
}

/**
 * Edits a server (or daemon) file in JAgentDesk's code editor (spec 25.5). Saves write back over
 * SFTP; if the file changed on the server since it was opened, the editor asks before
 * overwriting. Source editing is web/desktop only, like every other file in the app.
 */
export function SftpFileEditor({
  api,
  scope,
  endpoint,
  endpointLabel,
  path,
  onClose,
}: {
  api: SftpApi;
  scope: string;
  endpoint: SftpEndpoint;
  endpointLabel: string;
  path: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  // Read once per open: the editor model owns the content afterwards, and a background refetch
  // must not replace what the user is typing.
  const file = useFetchQuery({
    queryKey: ["ssh-sftp-file", scope, endpointKey(endpoint), path],
    queryFn: () => api.read(endpoint, path),
    dataShape: "value",
    staleTimeMs: 24 * 60 * 60 * 1000,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const retry = useCallback(() => void file.refetch(), [file]);
  const name = basename(path);

  let body;
  if (file.isPending) {
    body = (
      <View style={styles.center}>
        <Spinner />
        <Text style={styles.statusText}>{t("ssh.sftp.editor.opening", { name })}</Text>
      </View>
    );
  } else if (file.isError) {
    body = (
      <View style={styles.center}>
        <Text style={styles.title}>{t("ssh.sftp.editor.openFailed", { name })}</Text>
        <Text style={styles.statusText}>
          {file.error instanceof Error ? file.error.message : String(file.error)}
        </Text>
        <Button size="sm" variant="outline" onPress={retry}>
          {t("common.actions.retry")}
        </Button>
      </View>
    );
  } else {
    body = <EditorBody api={api} endpoint={endpoint} path={path} opened={file.data} />;
  }

  return (
    <View style={styles.container} testID="sftp-file-editor">
      <View style={styles.header}>
        <View style={styles.flex}>
          <Text style={styles.title} numberOfLines={1}>
            {name}
          </Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {`${endpointLabel}: ${path}`}
          </Text>
        </View>
        <IconButton icon={ThemedX} label={t("common.actions.close")} onPress={onClose} />
      </View>
      {body}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  flex: {
    flex: 1,
    minHeight: 0,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  title: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  subtitle: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
  },
  statusRow: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  statusText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  statusError: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.destructive,
  },
}));
