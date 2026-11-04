import { useCallback, useEffect, useMemo, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Buffer } from "buffer";
import { FileText, Trash2, Upload } from "lucide-react-native";
import {
  JIRA_ATTACHMENT_MAX_BYTES,
  type JiraAttachment,
  type JiraIssueDetail,
} from "@jagentdesk/protocol/jira/rpc-schemas";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { isWeb } from "@/constants/platform";
import { useFilePicker } from "@/hooks/use-file-picker";
import type { Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import { errorMessage, useJiraCall, type JiraCall } from "../api";
import { useJiraInvalidate } from "../queries";
import { ErrorBanner, IconButton, tint } from "../ui/primitives";
import { jiraStyles } from "../ui/styles";
import { Spinner } from "./controls";
import { formatBytes, useAsyncAction } from "./shared";

const ThemedFileText = withUnistyles(FileText);
const ThemedTrash = withUnistyles(Trash2);

// Attachments (spec 29.3, criterion 9): the daemon proxies the bytes — the app never receives a
// Jira URL — so previews are data URIs built from jira.issue.attachments.download responses.

interface Props {
  serverId: string;
  connectionId: string;
  issue: JiraIssueDetail;
}

interface LoadedFile {
  uri: string;
  mimeType: string;
  dataBase64: string;
  fileName: string;
}

async function fetchFile(
  call: JiraCall,
  connectionId: string,
  attachmentId: string,
  variant: "content" | "thumbnail",
): Promise<LoadedFile> {
  const file = await call("jira.issue.attachments.download.request", {
    connectionId,
    attachmentId,
    variant,
  });
  return {
    uri: `data:${file.mimeType};base64,${file.dataBase64}`,
    mimeType: file.mimeType,
    dataBase64: file.dataBase64,
    fileName: file.fileName,
  };
}

function downloadOnWeb(file: LoadedFile): void {
  const bytes = Buffer.from(file.dataBase64, "base64");
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: file.mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = file.fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; file: LoadedFile }
  | { kind: "failed"; message: string };

/** Loads one attachment variant through the daemon. */
function useAttachmentFile(
  serverId: string,
  connectionId: string,
  attachmentId: string,
  variant: "content" | "thumbnail",
): LoadState {
  const call = useJiraCall(serverId);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  useEffect(() => {
    setState({ kind: "loading" });
    let cancelled = false;
    const load = async () => {
      try {
        const file = await fetchFile(call, connectionId, attachmentId, variant);
        if (!cancelled) setState({ kind: "loaded", file });
      } catch (caught) {
        if (!cancelled) setState({ kind: "failed", message: errorMessage(caught) });
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [attachmentId, call, connectionId, variant]);
  return state;
}

function DataImage({ uri, full, label }: { uri: string; full: boolean; label: string }) {
  const source = useMemo(() => ({ uri }), [uri]);
  return (
    <Image
      source={source}
      style={full ? styles.fullImage : styles.thumbImage}
      resizeMode={full ? "contain" : "cover"}
      accessibilityLabel={label}
    />
  );
}

interface AttachmentProps {
  serverId: string;
  connectionId: string;
  attachment: JiraAttachment;
}

function Thumbnail({ serverId, connectionId, attachment }: AttachmentProps) {
  const variant = attachment.hasThumbnail ? "thumbnail" : "content";
  const state = useAttachmentFile(serverId, connectionId, attachment.id, variant);
  if (state.kind === "failed") return <ThemedFileText size={28} uniProps={tint.muted} />;
  if (state.kind === "loading") return <Spinner />;
  return <DataImage uri={state.file.uri} full={false} label={attachment.filename} />;
}

function AttachmentTile({
  serverId,
  connectionId,
  attachment,
  onOpen,
}: AttachmentProps & { onOpen: (attachment: JiraAttachment) => void }) {
  const call = useJiraCall(serverId);
  const invalidate = useJiraInvalidate(serverId, connectionId);
  const isImage = attachment.mimeType.startsWith("image/");
  const remove = useAsyncAction(
    useCallback(async () => {
      const confirmed = await confirmDialog({
        title: "Delete attachment",
        message: `Delete ${attachment.filename} from Jira?`,
        confirmLabel: "Delete",
        destructive: true,
      });
      if (!confirmed) return;
      await call("jira.issue.attachments.delete.request", {
        connectionId,
        attachmentId: attachment.id,
      });
      await invalidate();
    }, [attachment.filename, attachment.id, call, connectionId, invalidate]),
  );
  const { run } = remove;
  const open = useCallback(() => onOpen(attachment), [attachment, onOpen]);
  const removeNow = useCallback(() => void run(), [run]);
  return (
    <View style={styles.tile} testID={`jira-attachment-${attachment.id}`}>
      <Pressable
        style={styles.thumb}
        onPress={open}
        accessibilityRole="button"
        accessibilityLabel={`Open ${attachment.filename}`}
      >
        {isImage ? (
          <Thumbnail serverId={serverId} connectionId={connectionId} attachment={attachment} />
        ) : (
          <ThemedFileText size={28} uniProps={tint.muted} />
        )}
      </Pressable>
      <View style={jiraStyles.row}>
        <View style={jiraStyles.spacer}>
          <Text style={jiraStyles.textSmall} numberOfLines={1}>
            {attachment.filename}
          </Text>
          <Text style={jiraStyles.textSmall}>{formatBytes(attachment.size)}</Text>
        </View>
        {remove.pending ? (
          <Spinner />
        ) : (
          <IconButton
            icon={ThemedTrash}
            label={`Delete ${attachment.filename}`}
            onPress={removeNow}
          />
        )}
      </View>
      {remove.error ? <Text style={jiraStyles.errorText}>{remove.error}</Text> : null}
    </View>
  );
}

function ViewerBody({ serverId, connectionId, attachment }: AttachmentProps) {
  const state = useAttachmentFile(serverId, connectionId, attachment.id, "content");
  const isImage = attachment.mimeType.startsWith("image/");
  const file = state.kind === "loaded" ? state.file : null;
  const download = useCallback(() => {
    if (file) downloadOnWeb(file);
  }, [file]);
  return (
    <View style={jiraStyles.sheetBody}>
      {state.kind === "failed" ? <ErrorBanner message={state.message} /> : null}
      {state.kind === "loading" ? <Spinner /> : null}
      {file && isImage ? <DataImage uri={file.uri} full label={attachment.filename} /> : null}
      {file && !isImage ? (
        <Text
          style={jiraStyles.textMuted}
        >{`${file.mimeType}, ${formatBytes(attachment.size)}`}</Text>
      ) : null}
      {file && isWeb ? (
        <View style={jiraStyles.sheetFooter}>
          <Button size="sm" variant="outline" onPress={download} testID="jira-attachment-download">
            Download
          </Button>
        </View>
      ) : null}
    </View>
  );
}

function Viewer({
  serverId,
  connectionId,
  attachment,
  onClose,
}: {
  serverId: string;
  connectionId: string;
  attachment: JiraAttachment | null;
  onClose: () => void;
}) {
  const header = useMemo(() => ({ title: attachment?.filename ?? "Attachment" }), [attachment]);
  return (
    <AdaptiveModalSheet
      header={header}
      visible={attachment !== null}
      onClose={onClose}
      testID="jira-attachment-viewer"
    >
      {attachment ? (
        <ViewerBody serverId={serverId} connectionId={connectionId} attachment={attachment} />
      ) : null}
    </AdaptiveModalSheet>
  );
}

export function IssueAttachments({ serverId, connectionId, issue }: Props) {
  const call = useJiraCall(serverId);
  const invalidate = useJiraInvalidate(serverId, connectionId);
  const { pickFiles } = useFilePicker();
  const [open, setOpen] = useState<JiraAttachment | null>(null);
  const upload = useAsyncAction(
    useCallback(async () => {
      const files = await pickFiles();
      if (!files) return;
      for (const file of files) {
        const bytes = await file.readBytes();
        if (bytes.length > JIRA_ATTACHMENT_MAX_BYTES) {
          throw new Error(`${file.fileName} is larger than 10 MB, the upload limit here.`);
        }
        await call("jira.issue.attachments.upload.request", {
          connectionId,
          issueKey: issue.key,
          fileName: file.fileName,
          mimeType: file.mimeType,
          dataBase64: Buffer.from(bytes).toString("base64"),
        });
      }
      await invalidate();
    }, [call, connectionId, invalidate, issue.key, pickFiles]),
  );
  const { run } = upload;
  const startUpload = useCallback(() => void run(), [run]);
  const closeViewer = useCallback(() => setOpen(null), []);
  return (
    <View style={jiraStyles.sheetBody} testID="jira-issue-attachments">
      <View style={jiraStyles.row}>
        <Text style={jiraStyles.sectionLabel}>{`Attachments (${issue.attachments.length})`}</Text>
        <View style={jiraStyles.spacer} />
        <Button
          size="xs"
          variant="ghost"
          leftIcon={Upload}
          loading={upload.pending}
          onPress={startUpload}
          testID="jira-attachment-upload"
        >
          Upload
        </Button>
      </View>
      {upload.error ? <ErrorBanner message={upload.error} /> : null}
      <View style={styles.grid}>
        {issue.attachments.map((attachment) => (
          <AttachmentTile
            key={attachment.id}
            serverId={serverId}
            connectionId={connectionId}
            attachment={attachment}
            onOpen={setOpen}
          />
        ))}
      </View>
      <Viewer
        serverId={serverId}
        connectionId={connectionId}
        attachment={open}
        onClose={closeViewer}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  tile: {
    width: 148,
    gap: theme.spacing[1],
    padding: theme.spacing[1.5],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  thumb: {
    height: 96,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  thumbImage: { width: "100%", height: "100%" },
  fullImage: { width: "100%", height: 420 },
}));
