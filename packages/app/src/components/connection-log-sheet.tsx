import * as Clipboard from "expo-clipboard";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { connectionDiagnostics } from "@jagentdesk/client/internal/daemon-client-transport";

import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { ScrollableCodeSurface, SurfaceCard } from "@/components/ui/scrollable-code-surface";
import { useToast } from "@/contexts/toast-context";
import { redactAppDiagnosticReport } from "@/diagnostics/app-diagnostic-report";
import { useConnectionLogSheetStore } from "@/diagnostics/connection-log-store";
import { useHosts } from "@/runtime/host-runtime";

const SNAP_POINTS = ["55%", "88%"];

const subscribe = (listener: () => void) => connectionDiagnostics.subscribe(listener);
const getVersion = () => connectionDiagnostics.getVersion();

/**
 * Settings → Diagnostics → Connection log. Shows the client's connection,
 * transport and handshake events (see `connection-diagnostics.ts` in the
 * client package) so a failure seen only on one device can be copied out.
 */
export function ConnectionLogHost() {
  const visible = useConnectionLogSheetStore((state) => state.visible);
  const close = useConnectionLogSheetStore((state) => state.close);
  return <ConnectionLogSheet visible={visible} onClose={close} />;
}

function ConnectionLogSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const hosts = useHosts();
  const version = useSyncExternalStore(subscribe, getVersion, getVersion);
  // `version` changes with every entry; saved host addresses and keys never belong in a copied log.
  const log = useMemo(
    () => redactAppDiagnosticReport(connectionDiagnostics.format(), hosts),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `version` is the store's change signal.
    [hosts, version],
  );

  const handleCopy = useCallback(() => {
    if (!log) return;
    void Clipboard.setStringAsync(log)
      .then(() => toast.copied(t("settings.diagnostics.connectionLog.copyLabel")))
      .catch(() => toast.error(t("settings.diagnostics.connectionLog.copyFailed")));
  }, [log, t, toast]);

  const handleClear = useCallback(() => {
    connectionDiagnostics.clear();
  }, []);

  const header = useMemo<SheetHeader>(
    () => ({
      title: t("settings.diagnostics.connectionLog.title"),
      actions: (
        <View style={styles.headerActions}>
          <Button
            variant="ghost"
            size="sm"
            onPress={handleClear}
            disabled={!log}
            testID="connection-log-clear"
          >
            {t("settings.diagnostics.connectionLog.clear")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onPress={handleCopy}
            disabled={!log}
            testID="connection-log-copy"
          >
            {t("settings.diagnostics.connectionLog.copy")}
          </Button>
        </View>
      ),
    }),
    [handleClear, handleCopy, log, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      snapPoints={SNAP_POINTS}
      scrollable={false}
      testID="connection-log-sheet"
    >
      {log ? (
        <ScrollableCodeSurface key={visible ? "visible" : "hidden"} maxHeight={520}>
          {log}
        </ScrollableCodeSurface>
      ) : (
        <SurfaceCard key={visible ? "visible" : "hidden"}>
          <Text style={styles.emptyText}>{t("settings.diagnostics.connectionLog.empty")}</Text>
        </SurfaceCard>
      )}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  emptyText: {
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
