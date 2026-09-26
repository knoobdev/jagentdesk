import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { SimDevice } from "@jagentdesk/protocol/simulator/rpc-schemas";
import type { Theme } from "@/styles/theme";

// Install a .app or .ipa onto one or more simulators at once. A device .ipa (App Store / real
// device build) cannot run on a simulator — that is surfaced per-device rather than hidden.

interface InstallResult {
  udid: string;
  ok: boolean;
  error: string | null;
}

const SNAP_POINTS = ["70%"];

export function SimInstallSheet({
  visible,
  client,
  devices,
  onClose,
}: {
  visible: boolean;
  client: DaemonClient | null;
  devices: readonly SimDevice[];
  onClose: () => void;
}) {
  const [filePath, setFilePath] = useState("");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<InstallResult[] | null>(null);

  const header = useMemo<SheetHeader>(() => ({ title: "Install app on simulators" }), []);

  const toggle = useCallback((udid: string) => {
    setSelected((prev) => ({ ...prev, [udid]: !prev[udid] }));
  }, []);

  const selectAllBooted = useCallback(() => {
    const next: Record<string, boolean> = {};
    for (const d of devices) if (d.isBooted) next[d.udid] = true;
    setSelected(next);
  }, [devices]);

  const handleInstall = useCallback(async () => {
    if (!client) return;
    const udids = devices.filter((d) => selected[d.udid]).map((d) => d.udid);
    if (udids.length === 0 || !filePath.trim()) return;
    setBusy(true);
    setResults(null);
    try {
      const res = await client.simulatorInstallBatch({ udids, filePath: filePath.trim() });
      setResults(res.results);
    } catch (err) {
      setResults(
        udids.map((udid) => ({
          udid,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })),
      );
    } finally {
      setBusy(false);
    }
  }, [client, devices, filePath, selected]);

  const selectedCount = devices.filter((d) => selected[d.udid]).length;

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      header={header}
      desktopMaxWidth={560}
      snapPoints={SNAP_POINTS}
      testID="sim-install-sheet"
    >
      <View style={styles.body}>
        <Text style={styles.label}>App file (.app or .ipa)</Text>
        <AdaptiveTextInput
          resetKey="install"
          initialValue=""
          onChangeText={setFilePath}
          placeholder="/path/to/App.app or /path/to/App.ipa"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!busy}
          style={styles.input}
          testID="sim-install-path"
        />
        <Text style={styles.hint}>
          Tip: iOS simulators run simulator builds only. App Store / device .ipa files (FB, TikTok…)
          cannot run on a simulator and will report an error.
        </Text>

        <View style={styles.deviceHead}>
          <Text style={styles.label}>Simulators ({selectedCount} selected)</Text>
          <Pressable onPress={selectAllBooted} hitSlop={8}>
            <Text style={styles.selectAll}>Select booted</Text>
          </Pressable>
        </View>
        <ScrollView style={styles.deviceList}>
          {devices.map((d) => (
            <DeviceCheck
              key={d.udid}
              device={d}
              checked={Boolean(selected[d.udid])}
              result={results?.find((r) => r.udid === d.udid) ?? null}
              onToggle={toggle}
            />
          ))}
        </ScrollView>

        <Button
          variant="default"
          onPress={handleInstall}
          loading={busy}
          disabled={selectedCount === 0 || !filePath.trim()}
          testID="sim-install-run"
        >
          {`Install on ${selectedCount} simulator${selectedCount === 1 ? "" : "s"}`}
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}

function DeviceCheck({
  device,
  checked,
  result,
  onToggle,
}: {
  device: SimDevice;
  checked: boolean;
  result: InstallResult | null;
  onToggle: (udid: string) => void;
}) {
  const handlePress = useCallback(() => onToggle(device.udid), [device.udid, onToggle]);
  return (
    <Pressable
      onPress={handlePress}
      style={styles.deviceRow}
      testID={`sim-install-dev-${device.udid}`}
    >
      <View style={checked ? styles.checkOn : styles.checkOff}>
        <Text style={styles.checkMark}>{checked ? "✓" : ""}</Text>
      </View>
      <View style={[styles.dot, device.isBooted ? styles.dotOn : styles.dotOff]} />
      <Text style={styles.deviceName} numberOfLines={1}>
        {device.name}
      </Text>
      {result ? (
        <Text style={result.ok ? styles.resultOk : styles.resultErr} numberOfLines={1}>
          {result.ok ? "installed" : (result.error ?? "failed")}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  body: { gap: theme.spacing[2], paddingBottom: theme.spacing[4] },
  label: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  input: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
  },
  hint: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  deviceHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: theme.spacing[2],
  },
  selectAll: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.primary,
    fontWeight: theme.fontWeight.semibold,
  },
  deviceList: { maxHeight: 240 },
  deviceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  checkOn: {
    width: 20,
    height: 20,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  checkOff: {
    width: 20,
    height: 20,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  checkMark: { color: "#fff", fontSize: 12, fontWeight: "700" },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotOn: { backgroundColor: theme.colors.success },
  dotOff: { backgroundColor: theme.colors.foregroundExtraMuted },
  deviceName: { flex: 1, minWidth: 0, fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  resultOk: { fontSize: theme.fontSize.xs, color: theme.colors.success },
  resultErr: { fontSize: theme.fontSize.xs, color: theme.colors.destructive, flexShrink: 1 },
}));
