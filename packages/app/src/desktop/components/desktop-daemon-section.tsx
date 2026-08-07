import { LoadingSpinner } from "@/components/ui/loading-spinner";
import React, { type ReactElement, useCallback, useMemo, useState } from "react";
import { Alert, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { settingsStyles } from "@/styles/settings";
import { SettingsSection } from "@/screens/settings/settings-section";
import { Copy, FileText, Activity } from "lucide-react-native";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { isVersionMismatch } from "@/desktop/runtime";
import {
  getCliDaemonStatus,
  restartDesktopDaemon,
  shouldUseDesktopDaemon,
} from "@/desktop/daemon/desktop-daemon";
import { useBuiltInDaemonManagement } from "@/desktop/hooks/use-built-in-daemon-management";
import { useDaemonStatus } from "@/desktop/hooks/use-daemon-status";
import { useDesktopSettings, type DesktopSettings } from "@/desktop/settings/desktop-settings";
import { resolveAppVersion } from "@/utils/app-version";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const ThemedActivity = withUnistyles(Activity);
const ThemedCopy = withUnistyles(Copy);
const ThemedFileText = withUnistyles(FileText);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

type DesktopDaemonSettings = DesktopSettings["daemon"];

function useKeepRunningAfterQuitToggle(args: {
  settings: DesktopDaemonSettings;
  updateSettings: (next: Partial<DesktopDaemonSettings>) => Promise<unknown>;
}) {
  const { settings, updateSettings } = args;
  const [isUpdatingKeepRunningAfterQuit, setIsUpdatingKeepRunningAfterQuit] = useState(false);

  const handleToggleKeepRunningAfterQuit = useCallback(() => {
    setIsUpdatingKeepRunningAfterQuit(true);
    void updateSettings({ keepRunningAfterQuit: !settings.keepRunningAfterQuit })
      .catch(() => {
        // useDesktopSettings owns the user-visible IPC error.
      })
      .finally(() => {
        setIsUpdatingKeepRunningAfterQuit(false);
      });
  }, [settings.keepRunningAfterQuit, updateSettings]);

  return { isUpdatingKeepRunningAfterQuit, handleToggleKeepRunningAfterQuit };
}

function useDaemonCliStatusModal() {
  const { t } = useTranslation();
  const [cliStatusOutput, setCliStatusOutput] = useState<string | null>(null);
  const [isCliStatusModalOpen, setIsCliStatusModalOpen] = useState(false);
  const [isLoadingCliStatus, setIsLoadingCliStatus] = useState(false);

  const handleOpenCliStatus = useCallback(async () => {
    setIsLoadingCliStatus(true);
    try {
      setCliStatusOutput(await getCliDaemonStatus());
      setIsCliStatusModalOpen(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCliStatusOutput(t("desktop.daemon.fullStatus.fetchFailed", { message }));
      setIsCliStatusModalOpen(true);
    } finally {
      setIsLoadingCliStatus(false);
    }
  }, [t]);

  const handleCopyCliStatus = useCallback(() => {
    if (!cliStatusOutput) {
      return;
    }
    void Clipboard.setStringAsync(cliStatusOutput)
      .then(() => {
        Alert.alert(t("common.states.copied"), t("desktop.daemon.fullStatus.copied"));
        return;
      })
      .catch((error) => {
        console.error("[Settings] Failed to copy daemon status", error);
      });
  }, [cliStatusOutput, t]);

  const handleCloseCliStatusModal = useCallback(() => setIsCliStatusModalOpen(false), []);

  return {
    cliStatusOutput,
    isCliStatusModalOpen,
    isLoadingCliStatus,
    handleCopyCliStatus,
    handleOpenCliStatus,
    handleCloseCliStatusModal,
  };
}

function useDaemonLogsModal(daemonLogs: { logPath?: string } | null) {
  const { t } = useTranslation();
  const [isLogsModalOpen, setIsLogsModalOpen] = useState(false);

  const handleCopyLogPath = useCallback(() => {
    const logPath = daemonLogs?.logPath;
    if (!logPath) {
      return;
    }

    void Clipboard.setStringAsync(logPath)
      .then(() => {
        Alert.alert(t("common.states.copied"), t("desktop.daemon.logs.copied"));
        return;
      })
      .catch((error) => {
        console.error("[Settings] Failed to copy log path", error);
        Alert.alert(t("common.errors.error"), t("desktop.daemon.logs.copyFailed"));
      });
  }, [daemonLogs?.logPath, t]);

  const handleOpenLogs = useCallback(() => {
    if (!daemonLogs) {
      return;
    }
    setIsLogsModalOpen(true);
  }, [daemonLogs]);

  const handleCloseLogsModal = useCallback(() => setIsLogsModalOpen(false), []);

  return { isLogsModalOpen, handleCopyLogPath, handleOpenLogs, handleCloseLogsModal };
}

interface DaemonLogsModalProps {
  visible: boolean;
  onClose: () => void;
  daemonLogs: { logPath?: string; contents?: string } | null;
}

function DaemonLogsModal({ visible, onClose, daemonLogs }: DaemonLogsModalProps) {
  const { t } = useTranslation();
  const header = useMemo<SheetHeader>(() => ({ title: t("desktop.daemon.logs.modalTitle") }), [t]);

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      header={header}
      testID="managed-daemon-logs-dialog"
      snapPoints={LOGS_MODAL_SNAP_POINTS}
    >
      <View style={styles.modalBody}>
        <Text style={settingsStyles.rowHint}>
          {daemonLogs?.logPath ?? t("desktop.daemon.logs.unavailable")}
        </Text>
        <Text style={styles.logOutput} selectable dataSet={CODE_SURFACE_DATASET}>
          {daemonLogs?.contents?.length ? daemonLogs.contents : t("desktop.daemon.logs.empty")}
        </Text>
      </View>
    </AdaptiveModalSheet>
  );
}

interface DaemonCliStatusModalProps {
  visible: boolean;
  onClose: () => void;
  cliStatusOutput: string | null;
  onCopy: () => void;
}

function DaemonCliStatusModal({
  visible,
  onClose,
  cliStatusOutput,
  onCopy,
}: DaemonCliStatusModalProps) {
  const { t } = useTranslation();
  const header = useMemo<SheetHeader>(
    () => ({ title: t("desktop.daemon.fullStatus.modalTitle") }),
    [t],
  );

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      header={header}
      testID="daemon-cli-status-dialog"
      snapPoints={CLI_STATUS_MODAL_SNAP_POINTS}
    >
      <View style={styles.modalBody}>
        <Text style={styles.logOutput} selectable dataSet={CODE_SURFACE_DATASET}>
          {cliStatusOutput ?? ""}
        </Text>
        <View style={styles.modalActions}>
          <Button variant="outline" size="sm" onPress={onClose}>
            {t("common.actions.close")}
          </Button>
          <Button size="sm" onPress={onCopy}>
            {t("common.actions.copy")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

interface DaemonInfoCardProps {
  daemonStatusStateText: string;
  daemonStatusDetailText: string;
  isDaemonManagementPaused: boolean;
  copyIcon: ReactElement;
  fileTextIcon: ReactElement;
  activityIcon: ReactElement;
  handleToggleDaemonManagement: () => void;
  isUpdatingDaemonManagement: boolean;
  keepRunningAfterQuit: boolean;
  handleToggleKeepRunningAfterQuit: () => void;
  isUpdatingKeepRunningAfterQuit: boolean;
  daemonLogs: { logPath?: string } | null;
  handleCopyLogPath: () => void;
  handleOpenLogs: () => void;
  handleRunCliStatus: () => void;
  isLoadingCliStatus: boolean;
}

function DaemonInfoCard(props: DaemonInfoCardProps) {
  const { t } = useTranslation();
  const {
    daemonStatusStateText,
    daemonStatusDetailText,
    isDaemonManagementPaused,
    copyIcon,
    fileTextIcon,
    activityIcon,
    handleToggleDaemonManagement,
    isUpdatingDaemonManagement,
    keepRunningAfterQuit,
    handleToggleKeepRunningAfterQuit,
    isUpdatingKeepRunningAfterQuit,
    daemonLogs,
    handleCopyLogPath,
    handleOpenLogs,
    handleRunCliStatus,
    isLoadingCliStatus,
  } = props;

  return (
    <View style={settingsStyles.card}>
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{t("desktop.daemon.status.title")}</Text>
          <Text style={settingsStyles.rowHint}>{t("desktop.daemon.status.builtInOnly")}</Text>
        </View>
        <View style={styles.statusValueGroup}>
          <Text style={styles.valueText}>{daemonStatusStateText}</Text>
          <Text style={styles.valueSubtext}>{daemonStatusDetailText}</Text>
        </View>
      </View>
      <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{t("desktop.daemon.management.title")}</Text>
          <Text style={settingsStyles.rowHint}>{t("desktop.daemon.management.hint")}</Text>
        </View>
        <Switch
          value={!isDaemonManagementPaused}
          onValueChange={handleToggleDaemonManagement}
          disabled={isUpdatingDaemonManagement}
          accessibilityLabel={t("desktop.daemon.management.title")}
        />
      </View>
      <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{t("desktop.daemon.keepRunning.title")}</Text>
          <Text style={settingsStyles.rowHint}>{t("desktop.daemon.keepRunning.hint")}</Text>
        </View>
        <Switch
          value={keepRunningAfterQuit}
          onValueChange={handleToggleKeepRunningAfterQuit}
          disabled={isUpdatingKeepRunningAfterQuit}
          accessibilityLabel={t("desktop.daemon.keepRunning.title")}
        />
      </View>
      <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{t("desktop.daemon.logs.title")}</Text>
          <Text style={settingsStyles.rowHint}>
            {daemonLogs?.logPath ?? t("desktop.daemon.logs.unavailable")}
          </Text>
        </View>
        <View style={styles.actionGroup}>
          {daemonLogs?.logPath ? (
            <Button variant="outline" size="sm" leftIcon={copyIcon} onPress={handleCopyLogPath}>
              {t("desktop.daemon.logs.copyPath")}
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            leftIcon={fileTextIcon}
            onPress={handleOpenLogs}
            disabled={!daemonLogs}
          >
            {t("desktop.daemon.logs.open")}
          </Button>
        </View>
      </View>
      <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{t("desktop.daemon.fullStatus.title")}</Text>
          <Text style={settingsStyles.rowHint}>{t("desktop.daemon.fullStatus.hint")}</Text>
        </View>
        <Button
          variant="outline"
          size="sm"
          leftIcon={activityIcon}
          onPress={handleRunCliStatus}
          disabled={isLoadingCliStatus}
        >
          {isLoadingCliStatus ? t("common.states.loading") : t("desktop.daemon.fullStatus.view")}
        </Button>
      </View>
    </View>
  );
}

export function LocalDaemonSection() {
  const { t } = useTranslation();
  const showSection = shouldUseDesktopDaemon();
  const appVersion = resolveAppVersion();
  const { settings, updateSettings, isLoading: isLoadingSettings } = useDesktopSettings();
  const [tailscaleAuthKey, setTailscaleAuthKey] = useState("");
  const [isSavingTailscaleKey, setIsSavingTailscaleKey] = useState(false);
  const daemonSettings = settings.daemon;
  const updateDaemonSettings = useCallback(
    (updates: Partial<DesktopDaemonSettings>) => updateSettings({ daemon: updates }),
    [updateSettings],
  );
  const { data, isLoading, error: statusError, setStatus, refetch } = useDaemonStatus();

  const daemonStatus = data?.status ?? null;
  const daemonLogs = data?.logs ?? null;
  const daemonVersion = daemonStatus?.version ?? null;

  const daemonVersionMismatch = isVersionMismatch(appVersion, daemonVersion);
  const daemonStatusStateText =
    statusError ??
    (daemonStatus?.status === "running"
      ? t("desktop.daemon.status.running")
      : t("desktop.daemon.status.notRunning"));
  const daemonStatusDetailText = t("desktop.daemon.status.pid", {
    pid: daemonStatus?.pid ? daemonStatus.pid : "—",
  });
  const isDaemonManagementPaused = !daemonSettings.manageBuiltInDaemon;

  const { isUpdating: isUpdatingDaemonManagement, toggle: handleToggleDaemonManagement } =
    useBuiltInDaemonManagement({
      daemonStatus,
      settings: daemonSettings,
      updateSettings: updateDaemonSettings,
      setStatus,
      refreshStatus: refetch,
    });
  const { isUpdatingKeepRunningAfterQuit, handleToggleKeepRunningAfterQuit } =
    useKeepRunningAfterQuitToggle({
      settings: daemonSettings,
      updateSettings: updateDaemonSettings,
    });

  const { isLogsModalOpen, handleCopyLogPath, handleOpenLogs, handleCloseLogsModal } =
    useDaemonLogsModal(daemonLogs);

  const {
    cliStatusOutput,
    isCliStatusModalOpen,
    isLoadingCliStatus,
    handleCopyCliStatus,
    handleOpenCliStatus,
    handleCloseCliStatusModal,
  } = useDaemonCliStatusModal();
  const handleRunCliStatus = useCallback(() => {
    void handleOpenCliStatus();
  }, [handleOpenCliStatus]);

  const handleSaveTailscaleKey = useCallback(() => {
    const authKey = tailscaleAuthKey.trim();
    if (!authKey) return;
    setIsSavingTailscaleKey(true);
    void updateSettings({ tailscale: { authKey } })
      .then(() => restartDesktopDaemon())
      .then(() => setTailscaleAuthKey(""))
      .finally(() => setIsSavingTailscaleKey(false));
  }, [tailscaleAuthKey, updateSettings]);

  const handleClearTailscaleKey = useCallback(() => {
    setIsSavingTailscaleKey(true);
    void updateSettings({ tailscale: { authKey: null } }).finally(() =>
      setIsSavingTailscaleKey(false),
    );
  }, [updateSettings]);

  const copyIcon = useMemo(
    () => <ThemedCopy size={ICON_SIZE.sm} uniProps={foregroundColorMapping} />,
    [],
  );
  const fileTextIcon = useMemo(
    () => <ThemedFileText size={ICON_SIZE.sm} uniProps={foregroundColorMapping} />,
    [],
  );
  const activityIcon = useMemo(
    () => <ThemedActivity size={ICON_SIZE.sm} uniProps={foregroundColorMapping} />,
    [],
  );

  if (!showSection) {
    return null;
  }

  return (
    <SettingsSection
      title={t("desktop.daemon.title")}
      testID="host-page-daemon-lifecycle-card"
    >
      {isLoading || isLoadingSettings ? (
        <View style={[settingsStyles.card, styles.loadingCard]}>
          <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
        </View>
      ) : (
        <>
          <DaemonInfoCard
            daemonStatusStateText={daemonStatusStateText}
            daemonStatusDetailText={daemonStatusDetailText}
            isDaemonManagementPaused={isDaemonManagementPaused}
            copyIcon={copyIcon}
            fileTextIcon={fileTextIcon}
            activityIcon={activityIcon}
            handleToggleDaemonManagement={handleToggleDaemonManagement}
            isUpdatingDaemonManagement={isUpdatingDaemonManagement}
            keepRunningAfterQuit={daemonSettings.keepRunningAfterQuit}
            handleToggleKeepRunningAfterQuit={handleToggleKeepRunningAfterQuit}
            isUpdatingKeepRunningAfterQuit={isUpdatingKeepRunningAfterQuit}
            daemonLogs={daemonLogs}
            handleCopyLogPath={handleCopyLogPath}
            handleOpenLogs={handleOpenLogs}
            handleRunCliStatus={handleRunCliStatus}
            isLoadingCliStatus={isLoadingCliStatus}
          />

          {daemonVersionMismatch ? (
            <View style={styles.warningCard}>
              <Text style={styles.warningText}>{t("desktop.daemon.versionMismatch")}</Text>
            </View>
          ) : null}

          <View style={[settingsStyles.card, styles.tailscaleCard]} testID="tailscale-settings-card">
            <Text style={settingsStyles.rowTitle}>Tailscale connection</Text>
            <Text style={settingsStyles.rowHint}>
              JAgentDesk uses Tailscale only for desktop/mobile daemon connections. The key is
              stored in the operating system secure storage and is never shown again.
            </Text>
            <Text style={styles.tailscaleStatus}>
              {settings.tailscale.authKeyConfigured ? "Auth key configured" : "Not configured"}
            </Text>
            <TextInput
              value={tailscaleAuthKey}
              onChangeText={setTailscaleAuthKey}
              placeholder="tskey-auth-…"
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.tailscaleInput}
              accessibilityLabel="Tailscale auth key"
            />
            <View style={styles.actionGroup}>
              <Button
                variant="default"
                size="sm"
                onPress={handleSaveTailscaleKey}
                disabled={isSavingTailscaleKey || tailscaleAuthKey.trim().length === 0}
              >
                Save auth key and restart daemon
              </Button>
              {settings.tailscale.authKeyConfigured ? (
                <Button
                  variant="outline"
                  size="sm"
                  onPress={handleClearTailscaleKey}
                  disabled={isSavingTailscaleKey}
                >
                  Remove auth key
                </Button>
              ) : null}
            </View>
          </View>
        </>
      )}

      <DaemonLogsModal
        visible={isLogsModalOpen}
        onClose={handleCloseLogsModal}
        daemonLogs={daemonLogs}
      />

      <DaemonCliStatusModal
        visible={isCliStatusModalOpen}
        onClose={handleCloseCliStatusModal}
        cliStatusOutput={cliStatusOutput}
        onCopy={handleCopyCliStatus}
      />
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  tailscaleCard: {
    marginTop: theme.spacing[3],
    gap: theme.spacing[2],
  },
  tailscaleStatus: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
  },
  tailscaleInput: {
    minHeight: 40,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    color: theme.colors.foreground,
    paddingHorizontal: theme.spacing[3],
    backgroundColor: theme.colors.background,
  },
  actionGroup: {
    flexDirection: "row",
    gap: theme.spacing[2],
    flexWrap: "wrap",
    justifyContent: "flex-end",
  },
  loadingCard: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[6],
  },
  statusValueGroup: {
    alignItems: "flex-end",
    gap: 2,
  },
  valueText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  valueSubtext: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  warningCard: {
    marginTop: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.palette.amber[500],
    backgroundColor: "rgba(245, 158, 11, 0.12)",
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  warningText: {
    color: theme.colors.palette.amber[500],
    fontSize: theme.fontSize.xs,
  },
  modalBody: {
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  logOutput: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    lineHeight: 18,
  },
  modalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));

const LOGS_MODAL_SNAP_POINTS = ["70%", "92%"];
const CLI_STATUS_MODAL_SNAP_POINTS = ["60%", "85%"];
