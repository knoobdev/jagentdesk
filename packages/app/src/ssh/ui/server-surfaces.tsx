import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { ServerEnvironment } from "@jagentdesk/protocol/ssh/environment-schemas";
import type {
  SshImportPreview,
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

export function environmentSummary(environment: ServerEnvironment): string {
  const os = environment.os;
  const parts = [
    os.prettyName ?? os.distroName ?? os.kernelName,
    `${os.kernelName} ${os.kernelRelease} ${os.arch}`,
    environment.cpuCores === null ? null : `${environment.cpuCores} cores`,
    gib(environment.memoryTotalBytes),
    environment.docker ? `Docker ${environment.docker.version ?? ""}`.trim() : null,
    environment.kubectl ? "kubectl" : null,
    environment.psql ? "psql" : null,
    environment.systemctl ? "systemd" : null,
  ];
  return parts.filter((part): part is string => Boolean(part)).join(" · ");
}

function useServerEnvironment(client: DaemonClient | null, serverId: string, connected: boolean) {
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
  const [target, setTarget] = useState<SshDockerTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function attach(): Promise<void> {
      try {
        const res = await client.sshDockerAttach({ serverId });
        if (cancelled) return;
        if (res.dockerHost) setTarget({ serverId, dockerHost: res.dockerHost });
        else setError(res.error ?? "Docker is not reachable on this server");
      } catch (caught) {
        if (!cancelled) setError(errorText(caught));
      }
    }
    void attach();
    return () => {
      cancelled = true;
      void client.sshDockerDetach({ serverId }).catch(() => undefined);
    };
  }, [client, serverId]);
  if (error) return <ErrorBanner message={error} />;
  if (!target) return <Text style={styles.muted}>Connecting to Docker on the server…</Text>;
  return <DockerScreen sshDocker={target} hostServerId={hostServerId} />;
}

function LogsPanel({ client, serverId }: { client: DaemonClient; serverId: string }) {
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
        <Switch value={enabled} onValueChange={onToggle} accessibilityLabel="Record session logs" />
        <Text style={styles.text}>Record session logs for this server</Text>
      </View>
      {error ? <ErrorBanner message={error} /> : null}
      <View style={styles.row}>
        <TabButton
          label="Recent session"
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
          placeholder="Search this log"
          uniProps={placeholder}
          autoCapitalize="none"
        />
        <Button size="sm" variant="outline" onPress={onSearch}>
          Search
        </Button>
      </View>
      {source.kind === "recent" && hasRecent ? (
        <View style={styles.row}>
          <ThemedTextInput
            style={styles.input}
            value={comment}
            onChangeText={setComment}
            placeholder="Bookmark comment"
            uniProps={placeholder}
          />
          <Button size="sm" variant="outline" onPress={onBookmark}>
            Bookmark
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
        {matches ? null : (
          <Text style={styles.mono}>{text || "No log recorded for this server yet."}</Text>
        )}
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
        Install on server
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
              ? `Already in ${res.path}; the server now signs in with this key.`
              : `Added to ${res.path}; the server now signs in with this key.`,
          );
      } catch (caught) {
        setError(errorText(caught));
      } finally {
        setBusyKey(null);
      }
    },
    [client, serverId],
  );
  const onInstall = useCallback((keyId: string) => void install(keyId), [install]);
  if (keys.length === 0) {
    return <Text style={styles.muted}>Generate or import a key in Keychain first.</Text>;
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

type ServerPanel = "none" | "docker" | "logs" | "key";

/** Environment header plus Docker / Logs / Install key panels for one server (25.10, 25.13). */
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
  let summary = "Environment not detected yet";
  if (environment) summary = environmentSummary(environment);
  if (pending) summary = "Detecting the server environment…";
  return (
    <View style={styles.bar} testID="ssh-server-modules">
      <View style={styles.row}>
        <Text style={styles.summary} numberOfLines={2} testID="ssh-environment-summary">
          {summary}
        </Text>
        <Button size="xs" variant="ghost" onPress={redetect} disabled={pending || !client}>
          Re-detect
        </Button>
      </View>
      {error ? <ErrorBanner message={error} /> : null}
      <View style={styles.row}>
        {environment?.docker ? (
          <TabButton label="Docker" value="docker" active={panel === "docker"} onSelect={choose} />
        ) : null}
        <TabButton label="Logs" value="logs" active={panel === "logs"} onSelect={choose} />
        <TabButton
          label="Install public key"
          value="key"
          active={panel === "key"}
          onSelect={choose}
        />
      </View>
      {client && panel !== "none" ? (
        <View style={panel === "docker" ? styles.dockerPanel : styles.panel}>
          {panel === "docker" ? (
            <RemoteDocker client={client} hostServerId={hostServerId} serverId={server.id} />
          ) : null}
          {panel === "logs" ? <LogsPanel client={client} serverId={server.id} /> : null}
          {panel === "key" ? (
            <InstallKeyPanel client={client} serverId={server.id} keys={keys} />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

type ImportKind = SshImportSource["kind"];

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
  const header = useMemo<SheetHeader>(() => ({ title: "Import servers" }), []);
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
            label="~/.ssh on the daemon"
            value="ssh_directory"
            active={kind === "ssh_directory"}
            onSelect={selectKind}
          />
          <TabButton
            label="ssh_config"
            value="ssh_config"
            active={kind === "ssh_config"}
            onSelect={selectKind}
          />
          <TabButton label="CSV" value="csv" active={kind === "csv"} onSelect={selectKind} />
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
            Preview
          </Button>
          <Button size="sm" onPress={onApply} disabled={busy || !preview}>
            Import new servers
          </Button>
        </View>
        {error ? <ErrorBanner message={error} /> : null}
        {preview ? (
          <ScrollView style={styles.logBox}>
            {preview.servers.map((draft) => (
              <Text key={draft.draftId} style={styles.mono}>
                {`${draft.status === "new" ? "+" : "="} ${draft.label}  ${draft.username ? `${draft.username}@` : ""}${draft.address}${draft.port ? `:${draft.port}` : ""}${draft.jumpChain.length > 0 ? `  via ${draft.jumpChain.map((hop) => hop.alias ?? hop.address).join(" → ")}` : ""}`}
              </Text>
            ))}
            {preview.issues.map((issue) => (
              <Text
                key={`${issue.location.file}:${issue.location.line}:${issue.code}`}
                style={styles.muted}
              >
                {`${issue.location.file}:${issue.location.line} ${issue.severity === "skipped" ? "skipped" : "error"}: ${issue.message}`}
              </Text>
            ))}
          </ScrollView>
        ) : null}
        {result ? (
          <Text style={styles.text}>
            {`Added ${result.servers.added} · already saved ${result.servers.duplicates} · failed ${result.servers.failed.length}`}
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
