import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { StyleSheet } from "react-native-unistyles";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { ProxyCaptureSession } from "@jagentdesk/protocol/proxy/rpc-schemas";
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

  const start = useCallback(
    async (mode: "manual" | "system") => {
      if (!client) return;
      setBusy(true);
      setError(null);
      try {
        const res = await client.proxyCaptureStart({ mode });
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
  const handleStart = useCallback(() => start("manual"), [start]);
  const handleStartSystem = useCallback(() => start("system"), [start]);

  const handleStop = useCallback(
    async (id: string) => {
      if (!client) return;
      await client.proxyCaptureStop({ sessionId: id }).catch(() => {});
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
}: {
  session: ProxyCaptureSession;
  selected: boolean;
  onSelect: (id: string) => void;
  onStop: (id: string) => void;
}) {
  const running = session.state === "running";
  const handleSelect = useCallback(() => onSelect(session.id), [onSelect, session.id]);
  const handleStop = useCallback(() => onStop(session.id), [onStop, session.id]);
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
      ) : (
        <Text style={styles.stateTag}>{session.state}</Text>
      )}
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
}));
