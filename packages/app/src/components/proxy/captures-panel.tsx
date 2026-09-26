import { useCallback, useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { StyleSheet } from "react-native-unistyles";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { ProxyCaptureSession } from "@jagentdesk/protocol/proxy/rpc-schemas";
import type { SimDevice } from "@jagentdesk/protocol/simulator/rpc-schemas";
import type { Theme } from "@/styles/theme";
import { Button } from "@/components/ui/button";
import { WbButton } from "./wb-button";
import { WB_ORANGE } from "./workbench-constants";

// Capture management — Burp CE's "temporary project" made explicit. Start a listener, stop it, and
// pick the active session that feeds the Proxy / history tabs. The CA panel exports the root
// certificate to trust in a simulator (`xcrun simctl keychain booted add-root-cert <file>`) or any
// client, and shows the listener address to point traffic at. P1 uses manual capture; binding a
// session to one simulator via Frida arrives in a later phase.

interface FridaStatus {
  frida: boolean;
  version: string | null;
  installer: "pipx" | "pip3" | "pip" | null;
}

export function CapturesPanel({
  client,
  sessions,
  selectedSessionId,
  onSelectSession,
}: {
  client: DaemonClient | null;
  sessions: ProxyCaptureSession[];
  selectedSessionId: string | null;
  onSelectSession: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [caPem, setCaPem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frida, setFrida] = useState<FridaStatus | null>(null);
  const [installingFrida, setInstallingFrida] = useState(false);

  useEffect(() => {
    if (!client) return;
    void client
      .proxyFridaStatus()
      .then((s) => setFrida({ frida: s.frida, version: s.version, installer: s.installer }));
  }, [client]);

  const handleInstallFrida = useCallback(async () => {
    if (!client) return;
    setInstallingFrida(true);
    try {
      const res = await client.proxyFridaInstall();
      setFrida((prev) =>
        prev ? { ...prev, frida: res.frida } : { frida: res.frida, version: null, installer: null },
      );
      if (!res.ok) setError(res.log.slice(0, 400));
    } finally {
      setInstallingFrida(false);
    }
  }, [client]);

  const [configMode, setConfigMode] = useState<"manual" | "system" | null>(null);
  const start = useCallback(
    async (opts: {
      mode: "manual" | "system";
      udid?: string;
      label?: string;
      listenerPort?: number;
    }) => {
      if (!client) return;
      setConfigMode(null);
      setBusy(true);
      setError(null);
      try {
        const res = await client.proxyCaptureStart(opts);
        if (res.error) setError(res.error);
        else if (res.session) onSelectSession(res.session.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [client, onSelectSession],
  );
  const handleStart = useCallback(() => setConfigMode("manual"), []);
  const handleStartSystem = useCallback(() => setConfigMode("system"), []);
  const closeConfig = useCallback(() => setConfigMode(null), []);

  const handleStop = useCallback(
    async (id: string) => {
      if (!client) return;
      await client.proxyCaptureStop({ sessionId: id }).catch(() => {});
    },
    [client],
  );

  const handleRemove = useCallback(
    (id: string) => {
      if (client) client.proxySessionRemove({ sessionId: id });
    },
    [client],
  );

  const handleExportCa = useCallback(async () => {
    if (!client) return;
    const res = await client.proxyCaExport().catch(() => null);
    if (res?.pem) setCaPem(res.pem);
  }, [client]);

  const handleCopyCa = useCallback(() => {
    if (caPem) void Clipboard.setStringAsync(caPem);
  }, [caPem]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.toolbar}>
        <WbButton
          label="Capture simulators"
          onPress={handleStartSystem}
          loading={busy}
          testID="wb-capture-system"
        />
        <Button size="sm" variant="outline" onPress={handleStart} testID="wb-capture-start">
          Manual listener
        </Button>
        <Button size="sm" variant="outline" onPress={handleExportCa} testID="wb-ca-export">
          CA certificate
        </Button>
      </View>
      <Text style={styles.captureHint}>
        “Capture simulators” routes this Mac HTTP and HTTPS through the proxy — the reliable way to
        capture simulator apps, which ignore per-app proxy settings — and trusts the CA on booted
        simulators so HTTPS is decrypted. Stopping restores your proxy settings.
      </Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}

      <CaptureConfigModal mode={configMode} client={client} onStart={start} onClose={closeConfig} />

      {frida ? (
        <FridaCard status={frida} installing={installingFrida} onInstall={handleInstallFrida} />
      ) : null}

      {caPem ? <CaCard pem={caPem} onCopy={handleCopyCa} /> : null}

      <Text style={styles.sectionTitle}>Capture sessions</Text>
      {sessions.length === 0 ? (
        <Text style={styles.empty}>
          No capture sessions yet. Start one, then point a client at its listener.
        </Text>
      ) : (
        sessions.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            selected={s.id === selectedSessionId}
            onSelect={onSelectSession}
            onStop={handleStop}
            onRemove={handleRemove}
          />
        ))
      )}
    </ScrollView>
  );
}

// Frida status for TLS-unpinning. When Frida is missing the capture still works (CA-trusted TLS is
// captured for apps that do not pin); this card offers a one-click install so pinning apps can be
// unpinned, or tells the user how to install Frida if no Python installer is present.
function FridaCard({
  status,
  installing,
  onInstall,
}: {
  status: FridaStatus;
  installing: boolean;
  onInstall: () => void;
}) {
  if (status.frida) {
    return (
      <View style={styles.fridaOk}>
        <View style={styles.dotOnline} />
        <Text style={styles.fridaOkText}>
          Frida {status.version ?? ""} ready — apps that pin are unpinned automatically.
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.fridaCard}>
      <Text style={styles.fridaTitle}>Frida not installed</Text>
      <Text style={styles.fridaHint}>
        Capture still works for apps that do not pin. To also bypass TLS pinning, install Frida.
        {status.installer
          ? ""
          : " No pipx/pip found — install Python 3, then: pipx install frida-tools."}
      </Text>
      {status.installer ? (
        <WbButton
          label={installing ? "Installing…" : `Install Frida (${status.installer})`}
          onPress={onInstall}
          loading={installing}
          testID="wb-frida-install"
        />
      ) : null}
    </View>
  );
}

// Choose what to capture before starting — for "system" a specific booted simulator (its CA is
// trusted and the session is labelled with it, so you know which device you are aiming at); for
// "manual" an optional fixed listener port. Nothing starts until you confirm.
function CaptureConfigModal({
  mode,
  client,
  onStart,
  onClose,
}: {
  mode: "manual" | "system" | null;
  client: DaemonClient | null;
  onStart: (opts: {
    mode: "manual" | "system";
    udid?: string;
    label?: string;
    listenerPort?: number;
  }) => void;
  onClose: () => void;
}) {
  const [devices, setDevices] = useState<SimDevice[]>([]);
  const [udid, setUdid] = useState<string | null>(null);
  const [port, setPort] = useState("");

  useEffect(() => {
    if (mode !== "system" || !client) return;
    void client.simulatorList().then((res) => {
      const booted = res.devices.filter((d) => d.isBooted);
      setDevices(booted);
      setUdid(booted[0]?.udid ?? null);
      return undefined;
    });
  }, [mode, client]);

  const startSystem = useCallback(() => {
    const dev = devices.find((d) => d.udid === udid);
    onStart({
      mode: "system",
      udid: udid ?? undefined,
      label: dev ? `${dev.name} (system)` : "System capture",
    });
  }, [devices, onStart, udid]);

  const startManual = useCallback(() => {
    const p = Number(port);
    onStart({ mode: "manual", listenerPort: Number.isInteger(p) && p > 0 ? p : undefined });
  }, [onStart, port]);

  return (
    <Modal visible={mode != null} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.modalCard}>
          {mode === "system" ? (
            <>
              <Text style={styles.modalTitle}>Capture a simulator</Text>
              <Text style={styles.modalHint}>
                Routes this Mac traffic through the proxy and trusts the CA on the chosen simulator.
                All simulators share the Mac network, so pick which one to aim at (its HTTPS
                decrypts).
              </Text>
              <ScrollView style={styles.deviceList}>
                {devices.length === 0 ? (
                  <Text style={styles.modalHint}>
                    No booted simulators. Boot one on the Simulators screen.
                  </Text>
                ) : (
                  devices.map((d) => (
                    <DeviceChoice
                      key={d.udid}
                      device={d}
                      selected={d.udid === udid}
                      onSelect={setUdid}
                    />
                  ))
                )}
              </ScrollView>
              <View style={styles.modalActions}>
                <WbButton label="Cancel" variant="ghost" onPress={onClose} />
                <WbButton
                  label="Start capture"
                  onPress={startSystem}
                  disabled={devices.length === 0}
                />
              </View>
            </>
          ) : (
            <>
              <Text style={styles.modalTitle}>New manual listener</Text>
              <Text style={styles.modalHint}>
                Point a client at 127.0.0.1:&lt;port&gt;. Leave the port blank to auto-pick a free
                one.
              </Text>
              <TextInput
                style={styles.modalInput}
                value={port}
                onChangeText={setPort}
                placeholder="Port (optional, e.g. 8080)"
                keyboardType="number-pad"
              />
              <View style={styles.modalActions}>
                <WbButton label="Cancel" variant="ghost" onPress={onClose} />
                <WbButton label="Create listener" onPress={startManual} />
              </View>
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function DeviceChoice({
  device,
  selected,
  onSelect,
}: {
  device: SimDevice;
  selected: boolean;
  onSelect: (udid: string) => void;
}) {
  const handle = useCallback(() => onSelect(device.udid), [device.udid, onSelect]);
  return (
    <Pressable onPress={handle} style={styles.deviceChoice}>
      <View style={selected ? styles.radioOn : styles.radioOff} />
      <Text style={styles.deviceChoiceText} numberOfLines={1}>
        {device.name} · {device.runtime}
      </Text>
    </Pressable>
  );
}

function CaCard({ pem, onCopy }: { pem: string; onCopy: () => void }) {
  return (
    <View style={styles.caCard}>
      <Text style={styles.caTitle}>Workbench CA certificate</Text>
      <Text style={styles.caHint}>
        Trust this on a booted simulator so its HTTPS is inspectable:{"\n"}
        1. Save the text below as workbench-ca.pem{"\n"}
        2. xcrun simctl keychain booted add-root-cert workbench-ca.pem
      </Text>
      <ScrollView style={styles.caPem} horizontal>
        <Text style={styles.caPemText} selectable>
          {pem}
        </Text>
      </ScrollView>
      <Button size="sm" variant="outline" onPress={onCopy} testID="wb-ca-copy">
        Copy certificate
      </Button>
    </View>
  );
}

function SessionRow({
  session,
  selected,
  onSelect,
  onStop,
  onRemove,
}: {
  session: ProxyCaptureSession;
  selected: boolean;
  onSelect: (id: string) => void;
  onStop: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const running = session.state === "running";
  const handleSelect = useCallback(() => onSelect(session.id), [onSelect, session.id]);
  const handleStop = useCallback(() => onStop(session.id), [onStop, session.id]);
  const handleRemove = useCallback(() => onRemove(session.id), [onRemove, session.id]);
  return (
    <Pressable
      onPress={handleSelect}
      style={[styles.sessionRow, selected ? styles.sessionSelected : null]}
    >
      <View style={styles.sessionMain}>
        <View style={styles.sessionHead}>
          <View style={[styles.dot, running ? styles.dotOn : styles.dotOff]} />
          <Text style={styles.sessionLabel} numberOfLines={1}>
            {session.label}
          </Text>
        </View>
        <Text style={styles.sessionMeta} numberOfLines={1}>
          {session.mode} · {session.listenerHost}:{session.listenerPort || "—"} ·{" "}
          {session.transactionCount} reqs
          {session.udid ? ` · ${session.udid.slice(0, 8)}` : ""}
        </Text>
        {session.error ? <Text style={styles.error}>{session.error}</Text> : null}
      </View>
      {running ? (
        <Button size="sm" variant="destructive" onPress={handleStop} testID="wb-capture-stop">
          Stop
        </Button>
      ) : null}
      <Pressable
        onPress={handleRemove}
        hitSlop={6}
        style={styles.sessionRemove}
        testID="wb-session-remove"
      >
        <Text style={styles.sessionRemoveText}>✕</Text>
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.surface0 },
  content: { padding: theme.spacing[3], gap: theme.spacing[2] },
  toolbar: { flexDirection: "row", gap: theme.spacing[2], flexWrap: "wrap" },
  captureHint: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.xs },
  sectionTitle: {
    marginTop: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
  },
  empty: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  caCard: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
  },
  fridaOk: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  dotOnline: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.success },
  fridaOkText: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  fridaCard: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
  },
  fridaTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
  },
  fridaHint: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  caTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
  },
  caHint: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
  },
  caPem: {
    maxHeight: 120,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.sm,
    padding: theme.spacing[2],
  },
  caPemText: {
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
  },
  sessionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[2],
  },
  sessionSelected: { borderColor: WB_ORANGE },
  sessionMain: { flex: 1, minWidth: 0, gap: 2 },
  sessionHead: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotOn: { backgroundColor: theme.colors.success },
  dotOff: { backgroundColor: theme.colors.foregroundExtraMuted },
  sessionLabel: {
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  sessionMeta: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
  },
  stateTag: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  sessionRemove: { width: 26, height: 26, alignItems: "center", justifyContent: "center" },
  sessionRemoveText: { color: theme.colors.foregroundMuted, fontSize: 14 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  modalCard: {
    width: "100%",
    maxWidth: 440,
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  modalTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
  },
  modalHint: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  modalInput: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
    outlineWidth: 0,
  },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[2] },
  deviceList: { maxHeight: 220 },
  deviceChoice: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  radioOn: { width: 16, height: 16, borderRadius: 8, borderWidth: 5, borderColor: WB_ORANGE },
  radioOff: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  deviceChoiceText: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
}));
