import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { Theme } from "@/styles/theme";
import { deviceErrorCopy } from "@/screens/sim-device-errors";

// Android 11+ wireless debugging (spec 27.1): pair with the 6-digit code, then connect over TLS.
// The phone must be on the same network as the host running the daemon.

const SNAP_POINTS = ["75%"];

function parsePort(value: string): number | null {
  const port = Number.parseInt(value.trim(), 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

export function SimPairSheet({
  visible,
  client,
  onClose,
  onPaired,
}: {
  visible: boolean;
  client: DaemonClient | null;
  onClose: () => void;
  onPaired: (udid: string) => void;
}) {
  const [host, setHost] = useState("");
  const [pairingPort, setPairingPort] = useState("");
  const [code, setCode] = useState("");
  const [connectPort, setConnectPort] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const header = useMemo<SheetHeader>(() => ({ title: "Pair Android over Wi-Fi" }), []);

  const pairPort = parsePort(pairingPort);
  const devicePort = parsePort(connectPort);
  const ready =
    Boolean(host.trim()) && pairPort !== null && devicePort !== null && /^\d{6}$/.test(code.trim());

  const pair = useCallback(async () => {
    if (!client || pairPort === null || devicePort === null) return;
    setBusy(true);
    setError(null);
    try {
      const res = await client.simulatorPhysicalPairWireless({
        host: host.trim(),
        pairingPort: pairPort,
        pairingCode: code.trim(),
        connectPort: devicePort,
      });
      if (res.error) {
        setError(deviceErrorCopy(res.error));
        return;
      }
      onPaired(res.udid);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Pairing failed");
    } finally {
      setBusy(false);
    }
  }, [client, code, devicePort, host, onClose, onPaired, pairPort]);
  const submit = useCallback(() => void pair(), [pair]);

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      header={header}
      desktopMaxWidth={520}
      snapPoints={SNAP_POINTS}
      testID="sim-pair-sheet"
    >
      <View style={styles.body}>
        <Text style={styles.hint}>
          On the phone open Settings › Developer options › Wireless debugging. Tap Pair device with
          pairing code and copy the IP address, port and code it shows. The connect port is the one
          listed under IP address &amp; Port on the Wireless debugging screen.
        </Text>
        <Field
          label="IP address"
          value={host}
          onChange={setHost}
          placeholder="<phone IP>"
          testID="sim-pair-host"
        />
        <View style={styles.row}>
          <View style={styles.cell}>
            <Field
              label="Pairing port"
              value={pairingPort}
              onChange={setPairingPort}
              placeholder="<pairing port>"
              testID="sim-pair-port"
            />
          </View>
          <View style={styles.cell}>
            <Field
              label="Pairing code"
              value={code}
              onChange={setCode}
              placeholder="6 digits"
              testID="sim-pair-code"
            />
          </View>
        </View>
        <Field
          label="Connect port"
          value={connectPort}
          onChange={setConnectPort}
          placeholder="<connect port>"
          testID="sim-pair-connect-port"
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Button onPress={submit} loading={busy} disabled={!ready || busy} testID="sim-pair-run">
          Pair and connect
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  testID,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  testID: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <AdaptiveTextInput
        resetKey={testID}
        initialValue={value}
        onChangeText={onChange}
        placeholder={placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
        testID={testID}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  body: { gap: theme.spacing[3], paddingBottom: theme.spacing[4] },
  hint: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  row: { flexDirection: "row", gap: theme.spacing[2] },
  cell: { flex: 1, minWidth: 0 },
  field: { gap: theme.spacing[1] },
  label: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  input: {
    outlineWidth: 0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
  },
  error: { fontSize: theme.fontSize.sm, color: theme.colors.destructive },
}));
