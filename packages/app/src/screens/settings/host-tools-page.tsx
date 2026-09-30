import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type {
  HostCapability,
  HostCapabilityId,
  ToolInstallPlan,
} from "@jagentdesk/protocol/host-capabilities";
import { Button } from "@/components/ui/button";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { SettingsSection } from "@/screens/settings/settings-section";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";

/** Display order and names of the host capabilities (spec 24.2). */
const CAPABILITY_ROWS: { id: HostCapabilityId; label: string }[] = [
  { id: "iosSimulators", label: "iOS simulators" },
  { id: "androidDevices", label: "Android devices" },
  { id: "docker", label: "Docker" },
  { id: "helm", label: "Helm" },
  { id: "proxySystemCapture", label: "System proxy capture" },
  { id: "frida", label: "Frida" },
  { id: "tunnel", label: "Cloudflare Tunnel (cloudflared)" },
  { id: "maestro", label: "Maestro" },
  { id: "java", label: "Java 17+" },
  { id: "forgeGh", label: "GitHub CLI (gh)" },
  { id: "forgeGlab", label: "GitLab CLI (glab)" },
  { id: "forgeTea", label: "Gitea CLI (tea)" },
];

const MAX_PROGRESS_LINES = 8;

interface ProgressLine {
  id: number;
  text: string;
}

type InstallStage =
  | { kind: "loading" }
  | { kind: "plan"; plan: ToolInstallPlan }
  | { kind: "installing"; plan: ToolInstallPlan; lines: ProgressLine[] }
  | { kind: "done"; version: string | null }
  | { kind: "error"; message: string };

type HostClient = NonNullable<ReturnType<typeof useHostRuntimeClient>>;

function formatBytes(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function planStage(
  result: Awaited<ReturnType<HostClient["planHostTool"]>>,
  fallback: string,
): InstallStage {
  if (result.plan) return { kind: "plan", plan: result.plan };
  return { kind: "error", message: result.error?.message ?? fallback };
}

/** Plan on mount, then install on confirm, streaming output lines (spec 24.4). */
function useToolInstall(client: HostClient | null, tool: string) {
  const { t } = useTranslation();
  const [stage, setStage] = useState<InstallStage>({ kind: "loading" });

  useEffect(() => {
    if (!client) return undefined;
    let cancelled = false;
    const load = async () => {
      try {
        const result = await client.planHostTool(tool);
        if (!cancelled) setStage(planStage(result, t("settings.hostTools.planFailed")));
      } catch (error) {
        if (!cancelled) setStage({ kind: "error", message: errorText(error) });
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [client, t, tool]);

  const install = useCallback(async () => {
    if (!client || stage.kind !== "plan") return;
    const plan = stage.plan;
    setStage({ kind: "installing", plan, lines: [] });
    let nextId = 0;
    const onProgress = (text: string) => {
      nextId += 1;
      const line = { id: nextId, text };
      setStage((current) =>
        current.kind === "installing"
          ? { ...current, lines: [...current.lines, line].slice(-MAX_PROGRESS_LINES) }
          : current,
      );
    };
    try {
      const result = await client.installHostTool(plan.planId, { onProgress });
      setStage(
        result.ok
          ? { kind: "done", version: result.version }
          : {
              kind: "error",
              message: result.error?.message ?? t("settings.hostTools.installFailed"),
            },
      );
    } catch (error) {
      setStage({ kind: "error", message: errorText(error) });
    }
  }, [client, stage, t]);

  return { stage, install };
}

function PlanDetails({ plan }: { plan: ToolInstallPlan }) {
  const { t } = useTranslation();
  const size = formatBytes(plan.sizeBytes);
  const lines: string[] = [];
  if (plan.method === "package-manager" && plan.command) {
    lines.push(t("settings.hostTools.viaManager", { command: plan.command.join(" ") }));
  }
  if (plan.method === "release") {
    lines.push(t("settings.hostTools.viaRelease", { version: plan.version ?? "" }));
    if (plan.url) lines.push(plan.url);
    if (size) lines.push(t("settings.hostTools.size", { size }));
    lines.push(t("settings.hostTools.checksum"));
    if (plan.destination) {
      lines.push(t("settings.hostTools.destination", { path: plan.destination }));
    }
  }
  if (plan.method === "present") lines.push(t("settings.hostTools.present"));
  if (plan.method === "manual") lines.push(t("settings.hostTools.manual"));
  return (
    <View>
      {[...lines, ...plan.notes].map((line) => (
        <Text key={line} style={settingsStyles.rowHint} selectable>
          {line}
        </Text>
      ))}
    </View>
  );
}

function ToolInstallPanel({
  serverId,
  tool,
  onClose,
}: {
  serverId: string;
  tool: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const { stage, install } = useToolInstall(client, tool);
  const handleInstall = useCallback(() => {
    void install();
  }, [install]);

  if (stage.kind === "loading") {
    return <Text style={settingsStyles.rowHint}>{t("settings.hostTools.planning")}</Text>;
  }
  if (stage.kind === "error" || stage.kind === "done") {
    return (
      <View style={styles.panel}>
        {stage.kind === "error" ? (
          <Text style={settingsStyles.rowError}>{stage.message}</Text>
        ) : (
          <Text style={settingsStyles.rowHint}>
            {t("settings.hostTools.installed", { version: stage.version ?? "" })}
          </Text>
        )}
        <Button size="sm" variant="ghost" onPress={onClose}>
          {t("settings.hostTools.close")}
        </Button>
      </View>
    );
  }
  const { plan } = stage;
  const canInstall = plan.method === "package-manager" || plan.method === "release";
  return (
    <View style={styles.panel} testID={`host-tools-plan-${tool}`}>
      <PlanDetails plan={plan} />
      {stage.kind === "installing" ? (
        <View style={styles.log}>
          {stage.lines.map((line) => (
            <Text key={line.id} style={styles.logLine} numberOfLines={2}>
              {line.text}
            </Text>
          ))}
        </View>
      ) : null}
      <View style={styles.actions}>
        {canInstall ? (
          <Button
            size="sm"
            onPress={handleInstall}
            loading={stage.kind === "installing"}
            testID={`host-tools-install-confirm-${tool}`}
          >
            {t("settings.hostTools.install")}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onPress={onClose} disabled={stage.kind === "installing"}>
          {t("settings.hostTools.cancel")}
        </Button>
      </View>
    </View>
  );
}

function InstallToolButton({ tool, onPress }: { tool: string; onPress: (tool: string) => void }) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onPress(tool), [onPress, tool]);
  return (
    <Button size="sm" variant="outline" onPress={handlePress} testID={`host-tools-install-${tool}`}>
      {t("settings.hostTools.installTool", { tool })}
    </Button>
  );
}

function CapabilityRow({
  serverId,
  id,
  label,
  capability,
  first,
}: {
  serverId: string;
  id: HostCapabilityId;
  label: string;
  capability: HostCapability;
  first: boolean;
}) {
  const { t } = useTranslation();
  const [installing, setInstalling] = useState<string | null>(null);
  const handleClose = useCallback(() => setInstalling(null), []);
  const available = capability.state === "available";
  const status = available
    ? t("settings.hostTools.state.available", { version: capability.version ?? "" }).trim()
    : t(`settings.hostTools.state.${capability.state}`);
  const offerInstall = !available && !installing;
  return (
    <View style={[settingsStyles.row, !first && settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{label}</Text>
        <Text
          style={available ? settingsStyles.rowHint : styles.warning}
          testID={`host-tools-state-${id}`}
        >
          {status}
        </Text>
        {capability.reason ? <Text style={settingsStyles.rowHint}>{capability.reason}</Text> : null}
        {installing ? (
          <ToolInstallPanel serverId={serverId} tool={installing} onClose={handleClose} />
        ) : null}
      </View>
      {offerInstall
        ? capability.installable.map((tool) => (
            <InstallToolButton key={tool} tool={tool} onPress={setInstalling} />
          ))
        : null}
    </View>
  );
}

/** Settings → host → Tools: what this host can run and installing what is missing. */
export function HostToolsPage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const capabilities = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.capabilities?.host,
  );
  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = useCallback(() => {
    if (!client) return;
    setRefreshing(true);
    const run = async () => {
      try {
        await client.refreshHostCapabilities();
      } finally {
        setRefreshing(false);
      }
    };
    void run();
  }, [client]);

  if (!isConnected) {
    return (
      <View style={settingsStyles.card}>
        <Text style={settingsStyles.rowHint}>{t("settings.hostTools.offline")}</Text>
      </View>
    );
  }
  const rows = CAPABILITY_ROWS.filter((row) => capabilities?.[row.id]);
  return (
    <SettingsSection title={t("settings.hostTools.title")}>
      <Text style={styles.intro}>{t("settings.hostTools.intro")}</Text>
      <View style={styles.toolbar}>
        <Button
          size="sm"
          variant="outline"
          onPress={handleRefresh}
          loading={refreshing}
          testID="host-tools-refresh"
        >
          {t("settings.hostTools.refresh")}
        </Button>
      </View>
      <View style={settingsStyles.card} testID="host-tools-card">
        {rows.length === 0 ? (
          <Text style={settingsStyles.rowHint}>{t("settings.hostTools.unknown")}</Text>
        ) : (
          rows.map((row, index) => (
            <CapabilityRow
              key={row.id}
              serverId={serverId}
              id={row.id}
              label={row.label}
              capability={capabilities![row.id]!}
              first={index === 0}
            />
          ))
        )}
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  intro: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    marginBottom: theme.spacing[3],
  },
  toolbar: { flexDirection: "row", marginBottom: theme.spacing[3] },
  warning: { fontSize: theme.fontSize.sm, color: theme.colors.statusWarning },
  panel: {
    marginTop: theme.spacing[2],
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  log: { gap: 2 },
  logLine: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    fontFamily: "monospace",
  },
  actions: { flexDirection: "row", gap: theme.spacing[2] },
}));
