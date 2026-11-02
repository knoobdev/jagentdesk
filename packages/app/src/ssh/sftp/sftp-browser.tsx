import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { SftpEndpoint, SftpEntry, SshTransfer } from "@jagentdesk/protocol/ssh/sftp-schemas";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { SftpApi } from "./api";
import {
  SftpPane,
  labelForEndpoint as labelFor,
  type SftpEndpointOption,
  type SftpPaneState,
} from "./sftp-pane";
import { useTransferStore } from "./transfer-store";
import { SftpTransferQueue } from "./transfer-queue";

export interface SftpServerChoice {
  serverId: string;
  label: string;
}

export interface SftpDeviceDownloadReady {
  /** `cwd` and `path` for the existing file_download_token_request. */
  cwd: string;
  path: string;
  fileName: string;
}

type CompactTab = "left" | "right" | "transfers";

/**
 * Two-pane SFTP browser (spec 25.5, 25.13). Desktop shows both panes side by side with the
 * transfer queue below; compact layouts (phones) show one of left / right / transfers at a time.
 * Each pane is the daemon machine or any saved server, so local↔remote and remote↔remote work.
 */
export function SftpBrowser({
  api,
  scope,
  servers,
  daemonLabel,
  initialLeft,
  initialRight,
  onOpenFile,
  onDeviceDownloadReady,
  onUploadFromDevice,
}: {
  api: SftpApi;
  /** Cache scope for the daemon (its host id). */
  scope: string;
  servers: SftpServerChoice[];
  /** Label of the daemon machine's own pane, e.g. its hostname. */
  daemonLabel: string;
  initialLeft: SftpEndpoint;
  initialRight: SftpEndpoint;
  onOpenFile: (endpoint: SftpEndpoint, entry: SftpEntry) => void;
  /** Called once a server file staged for the device has finished copying to the daemon. */
  onDeviceDownloadReady?: (download: SftpDeviceDownloadReady) => void;
  /**
   * Uploads files picked on the device through the existing file upload flow and resolves with
   * their daemon paths; the browser then copies them into the pane's folder.
   */
  onUploadFromDevice?: () => Promise<string[]>;
}) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const { store, state: transfers } = useTransferStore(api);
  const [left, setLeft] = useState<SftpPaneState>({
    endpoint: initialLeft,
    path: "",
    showHidden: false,
  });
  const [right, setRight] = useState<SftpPaneState>({
    endpoint: initialRight,
    path: "",
    showHidden: false,
  });
  const [tab, setTab] = useState<CompactTab>("left");
  const pendingDownloads = useRef(new Map<string, SftpDeviceDownloadReady>());

  const endpointOptions = useMemo<SftpEndpointOption[]>(
    () => [
      { endpoint: { kind: "daemon" }, label: daemonLabel },
      ...servers.map((server) => ({
        endpoint: { kind: "server" as const, serverId: server.serverId },
        label: server.label,
      })),
    ],
    [daemonLabel, servers],
  );

  // Hand staged downloads to the device as soon as the daemon has the whole file.
  useEffect(() => {
    if (!onDeviceDownloadReady) return;
    for (const transfer of transfers.transfers) {
      const pending = pendingDownloads.current.get(transfer.id);
      if (!pending || transfer.status !== "completed") continue;
      pendingDownloads.current.delete(transfer.id);
      onDeviceDownloadReady(pending);
    }
  }, [onDeviceDownloadReady, transfers.transfers]);

  const downloadToDevice = useCallback(
    async (endpoint: SftpEndpoint, entry: SftpEntry) => {
      const download = await api.download(endpoint, entry.path);
      const ready = { cwd: download.cwd, path: download.path, fileName: entry.name };
      const known = store.getSnapshot().transfers.find((item) => item.id === download.transfer.id);
      // Small files can finish before this point; their completion push already went by.
      if (known?.status === "completed") onDeviceDownloadReady?.(ready);
      else pendingDownloads.current.set(download.transfer.id, ready);
    },
    [api, onDeviceDownloadReady, store],
  );
  const uploadInto = useCallback(
    async (endpoint: SftpEndpoint, dir: string) => {
      if (!onUploadFromDevice) return;
      const uploaded = await onUploadFromDevice();
      if (uploaded.length === 0) return;
      await api.copy({
        source: { kind: "daemon" },
        sourcePaths: uploaded,
        target: endpoint,
        targetDir: dir,
      });
    },
    [api, onUploadFromDevice],
  );
  const showTransfers = useCallback(
    (queued: SshTransfer[]) => {
      if (compact && queued.length > 0) setTab("transfers");
    },
    [compact],
  );

  const leftTarget = useMemo(
    () => ({
      endpoint: right.endpoint,
      dir: right.path,
      label: labelFor(endpointOptions, right.endpoint),
    }),
    [endpointOptions, right.endpoint, right.path],
  );
  const rightTarget = useMemo(
    () => ({
      endpoint: left.endpoint,
      dir: left.path,
      label: labelFor(endpointOptions, left.endpoint),
    }),
    [endpointOptions, left.endpoint, left.path],
  );
  const activeCount = transfers.transfers.filter(
    (transfer) => transfer.status === "running" || transfer.status === "queued",
  ).length;

  const paneProps = {
    api,
    scope,
    endpointOptions,
    compact,
    onOpenFile,
    onDownloadToDevice: onDeviceDownloadReady ? downloadToDevice : undefined,
    onUploadFromDevice: onUploadFromDevice ? uploadInto : undefined,
    onTransfersQueued: showTransfers,
  };
  const leftPane = (
    <SftpPane
      {...paneProps}
      state={left}
      onChange={setLeft}
      copyTarget={leftTarget}
      testID="sftp-pane-left"
    />
  );
  const rightPane = (
    <SftpPane
      {...paneProps}
      state={right}
      onChange={setRight}
      copyTarget={rightTarget}
      testID="sftp-pane-right"
    />
  );
  const queue = (
    <SftpTransferQueue api={api} store={store} state={transfers} testID="sftp-transfers" />
  );

  if (compact) {
    const options = [
      { value: "left" as const, label: labelFor(endpointOptions, left.endpoint) },
      { value: "right" as const, label: labelFor(endpointOptions, right.endpoint) },
      { value: "transfers" as const, label: t("ssh.sftp.transfers.tab", { count: activeCount }) },
    ];
    let content = queue;
    if (tab === "left") content = leftPane;
    else if (tab === "right") content = rightPane;
    return (
      <View style={styles.container}>
        <View style={styles.compactTabs}>
          <SegmentedControl options={options} value={tab} onValueChange={setTab} size="sm" />
        </View>
        <View style={styles.flex}>{content}</View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.panes}>
        {leftPane}
        <View style={styles.divider} />
        {rightPane}
      </View>
      <View style={styles.queue}>
        <Text style={styles.queueTitle}>{t("ssh.sftp.transfers.title")}</Text>
        {queue}
      </View>
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
  compactTabs: {
    padding: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  panes: {
    flex: 1,
    minHeight: 0,
    flexDirection: "row",
  },
  divider: {
    width: theme.borderWidth[1],
    backgroundColor: theme.colors.border,
  },
  queue: {
    height: 220,
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  queueTitle: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
}));
