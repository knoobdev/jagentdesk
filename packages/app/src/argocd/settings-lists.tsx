import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type {
  ArgoCdAppSet,
  ArgoCdCluster,
  ArgoCdProject,
  ArgoCdRepo,
} from "@jagentdesk/protocol/argocd/rpc-schemas";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import type { ArgoCdTone } from "./status";
import { errorMessage } from "./use-instances";

// Read-only settings lists of an instance (spec 30.3): ApplicationSets, Projects,
// Repositories, Clusters. The daemon already filtered every payload to an allowlist.

export type ArgoCdSettingsKind = "appsets" | "projects" | "repos" | "clusters";

interface SettingsRow {
  key: string;
  title: string;
  lines: string[];
  status: { label: string; tone: ArgoCdTone } | null;
  problem: string | null;
}

type ListState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "loaded"; rows: SettingsRow[] };

const EMPTY_TEXT: Record<ArgoCdSettingsKind, string> = {
  appsets: "No ApplicationSets",
  projects: "No projects",
  repos: "No repositories",
  clusters: "No clusters",
};

function connectionStatus(state: { status: string } | null): SettingsRow["status"] {
  if (!state?.status) return null;
  const tone: ArgoCdTone = state.status === "Successful" ? "success" : "danger";
  return { label: state.status, tone: state.status === "Unknown" ? "muted" : tone };
}

function joinDefined(parts: (string | null)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join(" · ");
}

function appSetRow(appSet: ArgoCdAppSet): SettingsRow {
  const error = appSet.conditions.find((condition) => condition.type.endsWith("Error"));
  return {
    key: `${appSet.namespace ?? ""}/${appSet.name}`,
    title: appSet.name,
    lines: [
      joinDefined([
        appSet.project ? `Project ${appSet.project}` : null,
        appSet.namespace,
        `${appSet.resources.length} applications`,
      ]),
      appSet.generators.length > 0 ? `Generators: ${appSet.generators.join(", ")}` : "",
    ].filter(Boolean),
    status: null,
    problem: error?.message ?? null,
  };
}

function destinationLabel(destination: ArgoCdProject["destinations"][number]): string {
  return `${destination.name ?? destination.server ?? "*"}/${destination.namespace ?? "*"}`;
}

function projectRow(project: ArgoCdProject): SettingsRow {
  return {
    key: project.name,
    title: project.name,
    lines: [
      project.description ?? "",
      project.sourceRepos.length > 0 ? `Sources: ${project.sourceRepos.join(", ")}` : "",
      project.destinations.length > 0
        ? `Destinations: ${project.destinations.map(destinationLabel).join(", ")}`
        : "",
    ].filter(Boolean),
    status: null,
    problem: null,
  };
}

function repoRow(repo: ArgoCdRepo): SettingsRow {
  const flags = [repo.insecure ? "insecure" : null, repo.enableOci ? "OCI" : null];
  return {
    key: repo.repo,
    title: repo.name ?? repo.repo,
    lines: [
      repo.name ? repo.repo : "",
      joinDefined([repo.type, repo.project ? `Project ${repo.project}` : null, ...flags]),
    ].filter(Boolean),
    status: connectionStatus(repo.connectionState),
    problem:
      repo.connectionState?.status === "Failed" ? (repo.connectionState.message ?? null) : null,
  };
}

function clusterRow(cluster: ArgoCdCluster): SettingsRow {
  const appCount =
    cluster.applicationsCount === null ? null : `${cluster.applicationsCount} applications`;
  return {
    key: cluster.server,
    title: cluster.name,
    lines: [
      cluster.server,
      joinDefined([
        cluster.serverVersion ? `Kubernetes ${cluster.serverVersion}` : null,
        appCount,
        cluster.namespaces.length > 0 ? `Namespaces: ${cluster.namespaces.join(", ")}` : null,
      ]),
    ].filter(Boolean),
    status: connectionStatus(cluster.connectionState),
    problem:
      cluster.connectionState?.status === "Failed"
        ? (cluster.connectionState.message ?? null)
        : null,
  };
}

type ListResult = { error: string } | { rows: SettingsRow[] };

async function loadRows(
  client: DaemonClient,
  instanceId: string,
  kind: ArgoCdSettingsKind,
): Promise<ListResult> {
  switch (kind) {
    case "appsets": {
      const res = await client.argocd("argocd.appsets.list.request", { instanceId });
      return res.error ? { error: res.error } : { rows: res.appsets.map(appSetRow) };
    }
    case "projects": {
      const res = await client.argocd("argocd.projects.list.request", { instanceId });
      return res.error ? { error: res.error } : { rows: res.projects.map(projectRow) };
    }
    case "repos": {
      const res = await client.argocd("argocd.repos.list.request", { instanceId });
      return res.error ? { error: res.error } : { rows: res.repos.map(repoRow) };
    }
    case "clusters": {
      const res = await client.argocd("argocd.clusters.list.request", { instanceId });
      return res.error ? { error: res.error } : { rows: res.clusters.map(clusterRow) };
    }
  }
}

export function ArgoCdSettingsList({
  client,
  instanceId,
  kind,
}: {
  client: DaemonClient;
  instanceId: string;
  kind: ArgoCdSettingsKind;
}) {
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    async function load() {
      try {
        const result = await loadRows(client, instanceId, kind);
        if (!active) return;
        setState(
          "error" in result
            ? { status: "error", error: result.error }
            : { status: "loaded", rows: result.rows },
        );
      } catch (error) {
        if (active) setState({ status: "error", error: errorMessage(error, "Unable to load") });
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [attempt, client, instanceId, kind]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  if (state.status === "loading") {
    return (
      <View style={styles.center}>
        <ThemedSpinner size="large" uniProps={mutedColor} />
      </View>
    );
  }
  if (state.status === "error") {
    return (
      <Alert variant="error" title="Unable to load" description={state.error}>
        <View style={styles.alertActions}>
          <Button size="sm" variant="outline" onPress={retry}>
            Retry
          </Button>
        </View>
      </Alert>
    );
  }
  if (state.rows.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.empty}>{EMPTY_TEXT[kind]}</Text>
      </View>
    );
  }
  return (
    <View style={settingsStyles.card} testID={`argocd-settings-${kind}`}>
      {state.rows.map((row, index) => (
        <View
          key={row.key}
          style={index === 0 ? styles.row : [styles.row, settingsStyles.rowBorder]}
        >
          <View style={styles.rowHeader}>
            <Text style={styles.title} numberOfLines={1}>
              {row.title}
            </Text>
            {row.status ? (
              <Text style={styles[TONE_TEXT[row.status.tone]]}>{row.status.label}</Text>
            ) : null}
          </View>
          {row.lines.map((line) => (
            <Text key={line} style={styles.line} numberOfLines={2}>
              {line}
            </Text>
          ))}
          {row.problem ? <Text style={styles.problem}>{row.problem}</Text> : null}
        </View>
      ))}
    </View>
  );
}

const TONE_TEXT = {
  success: "toneSuccess",
  info: "toneInfo",
  danger: "toneDanger",
  warning: "toneWarning",
  muted: "toneMuted",
} as const;

const ThemedSpinner = withUnistyles(LoadingSpinner);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const styles = StyleSheet.create((theme) => ({
  center: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 160,
  },
  empty: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  alertActions: {
    flexDirection: "row",
    marginTop: theme.spacing[2],
  },
  row: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[1],
  },
  rowHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  title: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  line: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  problem: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.statusDanger,
  },
  toneSuccess: { fontSize: theme.fontSize.xs, color: theme.colors.statusSuccess },
  toneInfo: { fontSize: theme.fontSize.xs, color: theme.colors.palette.blue[500] },
  toneDanger: { fontSize: theme.fontSize.xs, color: theme.colors.statusDanger },
  toneWarning: { fontSize: theme.fontSize.xs, color: theme.colors.statusWarning },
  toneMuted: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
}));
