import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { ServerEnvironment } from "@jagentdesk/protocol/ssh/environment-schemas";
import type {
  SshImportIssue,
  SshImportPreview,
  SshImportServerDraft,
  SshImportResult,
  SshImportSource,
  SshLogBookmark,
  SshLogSearchMatch,
  SshLogSource,
} from "@jagentdesk/protocol/ssh/logs-import-schemas";
import type { SshKey, SshServerInfo } from "@jagentdesk/protocol/ssh/rpc-schemas";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { DockerScreen } from "@/screens/docker-screen";
import type { Theme } from "@/styles/theme";
import { ErrorBanner, TabButton } from "./primitives";
import type { SshDockerTarget } from "./ssh-docker-client";

// Minimal surfaces for milestones S6–S8 on the server screen: the detected environment, the
// server's Docker in the existing cockpit, session logs, installing a public key; and the
// import sheet on the Servers list.

const ThemedTextInput = withUnistyles(TextInput);
const placeholder = (theme: Theme) => ({ placeholderTextColor: theme.colors.foregroundExtraMuted });

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function gib(bytes: number | null): string | null {
  return bytes === null ? null : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function environmentSummary(environment: ServerEnvironment, t: Translate): string {
  const os = environment.os;
  const parts = [
    os.prettyName ?? os.distroName ?? os.kernelName,
    `${os.kernelName} ${os.kernelRelease} ${os.arch}`,
    environment.cpuCores === null
      ? null
      : t("ssh.server.environment.cores", { count: environment.cpuCores }),
    gib(environment.memoryTotalBytes),
    environment.docker ? `Docker ${environment.docker.version ?? ""}`.trim() : null,
    environment.kubectl ? "kubectl" : null,
    environment.psql ? "psql" : null,
    environment.systemctl ? "systemd" : null,
  ];
  return parts.filter((part): part is string => Boolean(part)).join(" · ");
}

export function useServerEnvironment(
  client: DaemonClient | null,
  serverId: string,
  connected: boolean,
) {
  const [environment, setEnvironment] = useState<ServerEnvironment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const detect = useCallback(
    async (force: boolean) => {
      if (!client) return;
      setPending(true);
      try {
        const res = await client.sshEnvironmentDetect({ serverId, force });
        setEnvironment(res.environment);
        setError(res.error);
      } catch (caught) {
        setError(errorText(caught));
      } finally {
        setPending(false);
      }
    },
    [client, serverId],
  );
  useEffect(() => {
    if (connected) void detect(false);
  }, [connected, detect]);
  const redetect = useCallback(() => void detect(true), [detect]);
  return { environment, error, pending, redetect };
}

function RemoteDocker({
  client,
  hostServerId,
  serverId,
}: {
  client: DaemonClient;
  hostServerId: string;
  serverId: string;
}) {
  const { t } = useTranslation();
  const [target, setTarget] = useState<SshDockerTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function attach(): Promise<void> {
      try {
        const res = await client.sshDockerAttach({ serverId });
        if (cancelled) return;
        if (res.dockerHost) setTarget({ serverId, dockerHost: res.dockerHost });
        else setError(res.error ?? t("ssh.server.docker.unreachable"));
      } catch (caught) {
        if (!cancelled) setError(errorText(caught));
      }
    }
    void attach();
    return () => {
      cancelled = true;
      void client.sshDockerDetach({ serverId }).catch(() => undefined);
    };
  }, [client, serverId, t]);
  if (error) return <ErrorBanner message={error} />;
  if (!target) return <Text style={styles.muted}>{t("ssh.server.docker.connecting")}</Text>;
  return <DockerScreen sshDocker={target} hostServerId={hostServerId} />;
}

function LogsPanel({ client, serverId }: { client: DaemonClient; serverId: string }) {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(false);
  const [bookmarks, setBookmarks] = useState<SshLogBookmark[]>([]);
  const [hasRecent, setHasRecent] = useState(false);
  const [source, setSource] = useState<SshLogSource>({ kind: "recent", serverId });
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<SshLogSearchMatch[] | null>(null);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await client.sshLogsList();
      setError(res.error);
      setEnabled(res.enabledServerIds.includes(serverId));
      setBookmarks(res.bookmarks.filter((bookmark) => bookmark.serverId === serverId));
      setHasRecent(res.logs.some((log) => log.serverId === serverId));
    } catch (caught) {
      setError(errorText(caught));
    }
  }, [client, serverId]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (source.kind === "recent" && !hasRecent) {
      setText("");
      return;
    }
    let cancelled = false;
    async function read(): Promise<void> {
      try {
        const res = await client.sshLogsRead({ source });
        if (cancelled) return;
        setText(res.text);
        setError(res.error);
      } catch (caught) {
        if (!cancelled) setError(errorText(caught));
      }
    }
    void read();
    return () => {
      cancelled = true;
    };
  }, [client, hasRecent, source]);

  const toggle = useCallback(
    async (next: boolean) => {
      const res = await client.sshLogsSetEnabled({ serverId, enabled: next });
      setError(res.error);
      if (!res.error) setEnabled(next);
    },
    [client, serverId],
  );
  const onToggle = useCallback((next: boolean) => void toggle(next), [toggle]);
  const search = useCallback(async () => {
    if (!query.trim()) {
      setMatches(null);
      return;
    }
    const res = await client.sshLogsSearch({ source, query: query.trim() });
    setError(res.error);
    setMatches(res.matches);
  }, [client, query, source]);
  const onSearch = useCallback(() => void search(), [search]);
  const bookmark = useCallback(async () => {
    const res = await client.sshLogsBookmark({ serverId, comment });
    setError(res.error);
    if (res.bookmark) {
      setComment("");
      await load();
    }
  }, [client, comment, load, serverId]);
  const onBookmark = useCallback(() => void bookmark(), [bookmark]);
  const showRecent = useCallback(() => setSource({ kind: "recent", serverId }), [serverId]);
  const showBookmark = useCallback(
    (bookmarkId: string) => setSource({ kind: "bookmark", bookmarkId }),
    [],
  );

  return (
    <View style={styles.panelBody}>
      <View style={styles.row}>
        <Switch
          value={enabled}
          onValueChange={onToggle}
          accessibilityLabel={t("ssh.server.logs.record")}
        />
        <Text style={styles.text}>{t("ssh.server.logs.record")}</Text>
      </View>
      {error ? <ErrorBanner message={error} /> : null}
      <View style={styles.row}>
        <TabButton
          label={t("ssh.server.logs.recent")}
          value="recent"
          active={source.kind === "recent"}
          onSelect={showRecent}
        />
        {bookmarks.map((item) => (
          <TabButton
            key={item.id}
            label={item.comment || new Date(item.createdAtMs).toLocaleString()}
            value={item.id}
            active={source.kind === "bookmark" && source.bookmarkId === item.id}
            onSelect={showBookmark}
          />
        ))}
      </View>
      <View style={styles.row}>
        <ThemedTextInput
          style={styles.input}
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={onSearch}
          placeholder={t("ssh.server.logs.searchPlaceholder")}
          uniProps={placeholder}
          autoCapitalize="none"
        />
        <Button size="sm" variant="outline" onPress={onSearch}>
          {t("ssh.server.logs.search")}
        </Button>
      </View>
      {source.kind === "recent" && hasRecent ? (
        <View style={styles.row}>
          <ThemedTextInput
            style={styles.input}
            value={comment}
            onChangeText={setComment}
            placeholder={t("ssh.server.logs.commentPlaceholder")}
            uniProps={placeholder}
          />
          <Button size="sm" variant="outline" onPress={onBookmark}>
            {t("ssh.server.logs.bookmark")}
          </Button>
        </View>
      ) : null}
      <ScrollView style={styles.logBox}>
        {matches
          ? matches.map((match) => (
              <Text key={`${match.lineNumber}`} style={styles.mono}>
                {`${match.lineNumber}: ${match.line}`}
              </Text>
            ))
          : null}
        {matches ? null : <Text style={styles.mono}>{text || t("ssh.server.logs.empty")}</Text>}
      </ScrollView>
    </View>
  );
}

function InstallKeyRow({
  sshKey,
  busyKey,
  onInstall,
}: {
  sshKey: SshKey;
  busyKey: string | null;
  onInstall: (keyId: string) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onInstall(sshKey.id), [onInstall, sshKey.id]);
  return (
    <View style={styles.row}>
      <View style={styles.grow}>
        <Text style={styles.text}>{sshKey.label}</Text>
        <Text style={styles.mono}>{sshKey.fingerprintSha256}</Text>
      </View>
      <Button
        size="sm"
        variant="outline"
        loading={busyKey === sshKey.id}
        disabled={busyKey !== null}
        onPress={handlePress}
        testID={`ssh-install-key-${sshKey.id}`}
      >
        {t("ssh.server.installKey.install")}
      </Button>
    </View>
  );
}

function InstallKeyPanel({
  client,
  serverId,
  keys,
}: {
  client: DaemonClient;
  serverId: string;
  keys: SshKey[];
}) {
  const { t } = useTranslation();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const install = useCallback(
    async (keyId: string) => {
      setBusyKey(keyId);
      setError(null);
      setResult(null);
      try {
        const res = await client.sshKeysInstallToServer({ serverId, keyId });
        if (res.error) setError(res.error);
        else
          setResult(
            res.outcome === "already_present"
              ? t("ssh.server.installKey.alreadyPresent", { path: res.path })
              : t("ssh.server.installKey.added", { path: res.path }),
          );
      } catch (caught) {
        setError(errorText(caught));
      } finally {
        setBusyKey(null);
      }
    },
    [client, serverId, t],
  );
  const onInstall = useCallback((keyId: string) => void install(keyId), [install]);
  if (keys.length === 0) {
    return <Text style={styles.muted}>{t("ssh.server.installKey.noKeys")}</Text>;
  }
  return (
    <View style={styles.panelBody}>
      {keys.map((key) => (
        <InstallKeyRow key={key.id} sshKey={key} busyKey={busyKey} onInstall={onInstall} />
      ))}
      {result ? <Text style={styles.text}>{result}</Text> : null}
      {error ? <ErrorBanner message={error} /> : null}
    </View>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  secure = false,
  numeric = false,
  testID,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  secure?: boolean;
  numeric?: boolean;
  testID?: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.muted}>{label}</Text>
      <ThemedTextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        secureTextEntry={secure}
        keyboardType={numeric ? "number-pad" : "default"}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={label}
        uniProps={placeholder}
        testID={testID}
      />
    </View>
  );
}

export type RemoteDbEngine = "postgres" | "mysql";

const DEFAULT_DB_PORTS: Record<RemoteDbEngine, string> = { postgres: "5432", mysql: "3306" };

function parsePort(value: string): number | null {
  const port = Number(value.trim());
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/** spec 25.10: a database the server can reach, added to Databases through a tunnel. */
function RemoteDatabasePanel({
  client,
  server,
  engines,
}: {
  client: DaemonClient;
  server: SshServerInfo;
  engines: RemoteDbEngine[];
}) {
  const { t } = useTranslation();
  const [engine, setEngine] = useState<RemoteDbEngine>(engines[0] ?? "postgres");
  const [remoteHost, setRemoteHost] = useState("127.0.0.1");
  const [remotePort, setRemotePort] = useState(DEFAULT_DB_PORTS[engines[0] ?? "postgres"]);
  const [database, setDatabase] = useState("");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const chooseEngine = useCallback((next: RemoteDbEngine) => {
    setEngine(next);
    setRemotePort(DEFAULT_DB_PORTS[next]);
  }, []);

  const submit = useCallback(async () => {
    const port = parsePort(remotePort);
    if (port === null) {
      setError(t("ssh.server.database.invalidPort"));
      return;
    }
    setBusy(true);
    setError(null);
    setAdded(null);
    try {
      const tunnel = await client.sshRemoteDbPrepare({
        serverId: server.id,
        kind: engine,
        remoteHost: remoteHost.trim(),
        remotePort: port,
      });
      if (!tunnel.connection) {
        setError(tunnel.error ?? t("ssh.server.docker.unreachable"));
        return;
      }
      const name = displayName.trim() || `${server.label} · ${database.trim() || engine}`;
      const res = await client.databaseAdd({
        engine: tunnel.connection.engine,
        displayName: name,
        config: {
          ...tunnel.connection.config,
          ...(database.trim() ? { database: database.trim() } : {}),
          ...(user.trim() ? { user: user.trim() } : {}),
          ...(password ? { password } : {}),
        },
      });
      if (res.error) setError(res.error);
      else {
        setAdded(name);
        setPassword("");
      }
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }, [client, database, displayName, engine, password, remoteHost, remotePort, server, t, user]);
  const onSubmit = useCallback(() => void submit(), [submit]);

  return (
    <ScrollView contentContainerStyle={styles.panelBody}>
      <Text style={styles.muted}>{t("ssh.server.database.hint")}</Text>
      <View style={styles.row}>
        <Text style={styles.muted}>{t("ssh.server.database.engine")}</Text>
        {engines.map((candidate) => (
          <TabButton
            key={candidate}
            label={candidate === "postgres" ? "PostgreSQL" : "MySQL"}
            value={candidate}
            active={engine === candidate}
            onSelect={chooseEngine}
          />
        ))}
      </View>
      <View style={styles.row}>
        <LabeledInput
          label={t("ssh.server.database.remoteHost")}
          value={remoteHost}
          onChange={setRemoteHost}
        />
        <LabeledInput
          label={t("ssh.server.database.remotePort")}
          value={remotePort}
          onChange={setRemotePort}
          numeric
        />
      </View>
      <View style={styles.row}>
        <LabeledInput
          label={t("ssh.server.database.database")}
          value={database}
          onChange={setDatabase}
        />
        <LabeledInput label={t("ssh.server.database.user")} value={user} onChange={setUser} />
        <LabeledInput
          label={t("ssh.server.database.password")}
          value={password}
          onChange={setPassword}
          secure
        />
      </View>
      <LabeledInput
        label={t("ssh.server.database.displayName")}
        value={displayName}
        onChange={setDisplayName}
      />
      <View style={styles.row}>
        <Button size="sm" onPress={onSubmit} loading={busy} testID="ssh-remote-db-add">
          {t("ssh.server.database.submit")}
        </Button>
      </View>
      {added ? (
        <Text style={styles.text}>{t("ssh.server.database.added", { name: added })}</Text>
      ) : null}
      {error ? <ErrorBanner message={error} /> : null}
    </ScrollView>
  );
}

/** spec 25.10: a cluster from the kubeconfig on the server, reached through the server. */
function RemoteClusterPanel({ client, server }: { client: DaemonClient; server: SshServerInfo }) {
  const { t } = useTranslation();
  const [kubeconfigPath, setKubeconfigPath] = useState(".kube/config");
  const [context, setContext] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (!context.trim()) {
      setError(t("ssh.server.kubernetes.contextRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    setImported(null);
    try {
      const prepared = await client.sshRemoteK8sImport({
        serverId: server.id,
        kubeconfigPath: kubeconfigPath.trim(),
        context: context.trim(),
      });
      if (!prepared.clusterInput) {
        setError(prepared.error ?? t("ssh.server.kubernetes.contextRequired"));
        return;
      }
      const name = displayName.trim() || prepared.clusterInput.displayName;
      const res = await client.clusterImport({
        contextName: prepared.clusterInput.contextName,
        displayName: name,
      });
      if (res.error) setError(res.error);
      else setImported(name);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }, [client, context, displayName, kubeconfigPath, server.id, t]);
  const onSubmit = useCallback(() => void submit(), [submit]);

  return (
    <ScrollView contentContainerStyle={styles.panelBody}>
      <Text style={styles.muted}>{t("ssh.server.kubernetes.hint")}</Text>
      <View style={styles.row}>
        <LabeledInput
          label={t("ssh.server.kubernetes.kubeconfigPath")}
          value={kubeconfigPath}
          onChange={setKubeconfigPath}
        />
        <LabeledInput
          label={t("ssh.server.kubernetes.context")}
          value={context}
          onChange={setContext}
          testID="ssh-remote-k8s-context"
        />
      </View>
      <LabeledInput
        label={t("ssh.server.kubernetes.displayName")}
        value={displayName}
        onChange={setDisplayName}
      />
      <View style={styles.row}>
        <Button size="sm" onPress={onSubmit} loading={busy} testID="ssh-remote-k8s-import">
          {t("ssh.server.kubernetes.submit")}
        </Button>
      </View>
      {imported ? (
        <Text style={styles.text}>{t("ssh.server.kubernetes.imported", { name: imported })}</Text>
      ) : null}
      {error ? <ErrorBanner message={error} /> : null}
    </ScrollView>
  );
}

export type ServerPanel = "none" | "docker" | "logs" | "key" | "database" | "kubernetes";

export function remoteDbEngines(environment: ServerEnvironment | null): RemoteDbEngine[] {
  if (!environment) return [];
  const engines: RemoteDbEngine[] = [];
  if (environment.psql) engines.push("postgres");
  if (environment.mysql) engines.push("mysql");
  return engines;
}

export function ServerPanelBody({
  panel,
  client,
  hostServerId,
  server,
  keys,
  dbEngines,
}: {
  panel: Exclude<ServerPanel, "none">;
  client: DaemonClient;
  hostServerId: string;
  server: SshServerInfo;
  keys: SshKey[];
  dbEngines: RemoteDbEngine[];
}) {
  switch (panel) {
    case "docker":
      return <RemoteDocker client={client} hostServerId={hostServerId} serverId={server.id} />;
    case "logs":
      return <LogsPanel client={client} serverId={server.id} />;
    case "key":
      return <InstallKeyPanel client={client} serverId={server.id} keys={keys} />;
    case "database":
      return <RemoteDatabasePanel client={client} server={server} engines={dbEngines} />;
    case "kubernetes":
      return <RemoteClusterPanel client={client} server={server} />;
  }
}

/**
 * Environment header plus Docker / Logs / Install key / database / Kubernetes panels for one
 * server (spec 25.10, 25.13). Docker, database and Kubernetes appear only when the detected
 * environment has them (Redis is not a Databases engine, so it has no entry).
 */
export function ServerModulesBar({
  client,
  hostServerId,
  server,
  keys,
  connected,
}: {
  client: DaemonClient | null;
  hostServerId: string;
  server: SshServerInfo;
  keys: SshKey[];
  connected: boolean;
}) {
  const { t } = useTranslation();
  const { environment, error, pending, redetect } = useServerEnvironment(
    client,
    server.id,
    connected,
  );
  const [panel, setPanel] = useState<ServerPanel>("none");
  const choose = useCallback(
    (next: ServerPanel) => setPanel((current) => (current === next ? "none" : next)),
    [],
  );
  const dbEngines = useMemo(() => remoteDbEngines(environment), [environment]);
  let summary = t("ssh.server.environment.notDetected");
  if (environment) summary = environmentSummary(environment, t);
  if (pending) summary = t("ssh.server.environment.detecting");
  return (
    <View style={styles.bar} testID="ssh-server-modules">
      <View style={styles.row}>
        <Text style={styles.summary} numberOfLines={2} testID="ssh-environment-summary">
          {summary}
        </Text>
        <Button size="xs" variant="ghost" onPress={redetect} disabled={pending || !client}>
          {t("ssh.server.environment.redetect")}
        </Button>
      </View>
      {error ? <ErrorBanner message={error} /> : null}
      <View style={styles.row}>
        {environment?.docker ? (
          <TabButton
            label={t("ssh.server.tabs.docker")}
            value="docker"
            active={panel === "docker"}
            onSelect={choose}
          />
        ) : null}
        <TabButton
          label={t("ssh.server.tabs.logs")}
          value="logs"
          active={panel === "logs"}
          onSelect={choose}
        />
        <TabButton
          label={t("ssh.server.tabs.installKey")}
          value="key"
          active={panel === "key"}
          onSelect={choose}
        />
        {dbEngines.length > 0 ? (
          <TabButton
            label={t("ssh.server.tabs.database")}
            value="database"
            active={panel === "database"}
            onSelect={choose}
            testID="ssh-server-tab-database"
          />
        ) : null}
        {environment?.kubectl ? (
          <TabButton
            label={t("ssh.server.tabs.kubernetes")}
            value="kubernetes"
            active={panel === "kubernetes"}
            onSelect={choose}
            testID="ssh-server-tab-kubernetes"
          />
        ) : null}
      </View>
      {client && panel !== "none" ? (
        <View style={panel === "docker" ? styles.dockerPanel : styles.panel}>
          <ServerPanelBody
            panel={panel}
            client={client}
            hostServerId={hostServerId}
            server={server}
            keys={keys}
            dbEngines={dbEngines}
          />
        </View>
      ) : null}
    </View>
  );
}

type ImportKind = SshImportSource["kind"];

function draftLine(draft: SshImportServerDraft, t: Translate): string {
  const user = draft.username ? `${draft.username}@` : "";
  const port = draft.port ? `:${draft.port}` : "";
  const hops = draft.jumpChain.map((hop) => hop.alias ?? hop.address).join(" → ");
  const via = hops ? `  ${t("ssh.import.via", { hops })}` : "";
  const marker = draft.status === "new" ? "+" : "=";
  return `${marker} ${draft.label}  ${user}${draft.address}${port}${via}`;
}

function issueLine(issue: SshImportIssue, t: Translate): string {
  const severity = issue.severity === "skipped" ? t("ssh.import.skipped") : t("ssh.import.error");
  return `${issue.location.file}:${issue.location.line} ${severity}: ${issue.message}`;
}

/** Import servers from the daemon's ~/.ssh, pasted ssh_config or CSV (spec 25.9). */
export function ImportServersSheet({
  client,
  onClose,
  onImported,
}: {
  client: DaemonClient | null;
  onClose: () => void;
  onImported: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<ImportKind>("ssh_directory");
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<SshImportPreview | null>(null);
  const [result, setResult] = useState<SshImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const source = useMemo<SshImportSource>(
    () => (kind === "ssh_directory" ? { kind } : { kind, text }),
    [kind, text],
  );
  const header = useMemo<SheetHeader>(() => ({ title: t("ssh.import.title") }), [t]);
  const selectKind = useCallback((next: ImportKind) => {
    setKind(next);
    setPreview(null);
    setResult(null);
  }, []);

  const run = useCallback(
    async (apply: boolean) => {
      if (!client) return;
      setBusy(true);
      setError(null);
      try {
        if (!apply) {
          const res = await client.sshImportPreview({ source });
          setError(res.error);
          setPreview(res.preview);
          return;
        }
        const res = await client.sshImportApply({
          source,
          importKnownHosts: kind === "ssh_directory",
          keyPaths: [],
        });
        setError(res.error);
        setResult(res.result);
        if (res.result) await onImported();
      } catch (caught) {
        setError(errorText(caught));
      } finally {
        setBusy(false);
      }
    },
    [client, kind, onImported, source],
  );

  const onPreview = useCallback(() => void run(false), [run]);
  const onApply = useCallback(() => void run(true), [run]);
  return (
    <AdaptiveModalSheet visible onClose={onClose} header={header} testID="ssh-import-sheet">
      <View style={styles.panelBody}>
        <View style={styles.row}>
          <TabButton
            label={t("ssh.import.sources.sshDirectory")}
            value="ssh_directory"
            active={kind === "ssh_directory"}
            onSelect={selectKind}
          />
          <TabButton
            label={t("ssh.import.sources.sshConfig")}
            value="ssh_config"
            active={kind === "ssh_config"}
            onSelect={selectKind}
          />
          <TabButton
            label={t("ssh.import.sources.csv")}
            value="csv"
            active={kind === "csv"}
            onSelect={selectKind}
          />
        </View>
        {kind === "ssh_directory" ? null : (
          <ThemedTextInput
            style={styles.textArea}
            value={text}
            onChangeText={setText}
            multiline
            placeholder={
              kind === "csv" ? "label,address,port,username,group,tags" : "Host name\n  HostName …"
            }
            uniProps={placeholder}
            autoCapitalize="none"
            autoCorrect={false}
          />
        )}
        <View style={styles.row}>
          <Button size="sm" variant="outline" onPress={onPreview} loading={busy}>
            {t("ssh.import.preview")}
          </Button>
          <Button size="sm" onPress={onApply} disabled={busy || !preview}>
            {t("ssh.import.apply")}
          </Button>
        </View>
        {error ? <ErrorBanner message={error} /> : null}
        {preview ? (
          <ScrollView style={styles.logBox}>
            {preview.servers.map((draft) => (
              <Text key={draft.draftId} style={styles.mono}>
                {draftLine(draft, t)}
              </Text>
            ))}
            {preview.issues.map((issue) => (
              <Text
                key={`${issue.location.file}:${issue.location.line}:${issue.code}`}
                style={styles.muted}
              >
                {issueLine(issue, t)}
              </Text>
            ))}
          </ScrollView>
        ) : null}
        {result ? (
          <Text style={styles.text}>
            {t("ssh.import.result", {
              added: result.servers.added,
              duplicates: result.servers.duplicates,
              failed: result.servers.failed.length,
            })}
          </Text>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  grow: { flex: 1, minWidth: 0 },
  summary: { flex: 1, minWidth: 0, fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  text: { fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  muted: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  mono: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  panel: { maxHeight: 360 },
  dockerPanel: { height: 480 },
  panelBody: { gap: theme.spacing[2] },
  field: { flex: 1, minWidth: 140, gap: theme.spacing[1] },
  input: {
    flex: 1,
    minWidth: 160,
    height: 32,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  textArea: {
    minHeight: 140,
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    textAlignVertical: "top",
  },
  logBox: {
    maxHeight: 220,
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
  },
}));
