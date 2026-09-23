import { useCallback, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useMutation } from "@tanstack/react-query";
import { BackHeader } from "@/components/headers/back-header";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useFetchQuery } from "@/data/query";
import { useToast } from "@/contexts/toast-context";
import { useHostRouteServerId } from "@/navigation/host-route-context";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import type {
  DockerAction,
  DockerContainer,
  DockerImage,
} from "@jagentdesk/protocol/docker/rpc-schemas";

const RUNNING_STATES = new Set(["running", "restarting"]);

interface ContainerRowProps {
  container: DockerContainer;
  onAction: (input: { container: string; action: DockerAction }) => void;
  onLogs: (container: string) => void;
  busy: boolean;
}

function ContainerRow({ container, onAction, onLogs, busy }: ContainerRowProps) {
  const running = RUNNING_STATES.has(container.state);
  const stop = useCallback(
    () => onAction({ container: container.id, action: "stop" }),
    [onAction, container.id],
  );
  const start = useCallback(
    () => onAction({ container: container.id, action: "start" }),
    [onAction, container.id],
  );
  const restart = useCallback(
    () => onAction({ container: container.id, action: "restart" }),
    [onAction, container.id],
  );
  const remove = useCallback(
    () => onAction({ container: container.id, action: "remove" }),
    [onAction, container.id],
  );
  const logs = useCallback(() => onLogs(container.id), [onLogs, container.id]);
  return (
    <View style={styles.row}>
      <View style={styles.rowHead}>
        <View style={[styles.dot, running ? styles.dotOn : styles.dotOff]} />
        <Text style={styles.name} numberOfLines={1}>
          {container.name || container.id.slice(0, 12)}
        </Text>
      </View>
      <Text style={styles.meta} numberOfLines={1}>
        {container.image}
      </Text>
      <Text style={styles.status} numberOfLines={1}>
        {container.status}
        {container.ports ? ` · ${container.ports}` : ""}
      </Text>
      <View style={styles.actions}>
        {running ? (
          <Button size="xs" variant="outline" onPress={stop} disabled={busy}>
            Stop
          </Button>
        ) : (
          <Button size="xs" variant="outline" onPress={start} disabled={busy}>
            Start
          </Button>
        )}
        <Button size="xs" variant="outline" onPress={restart} disabled={busy}>
          Restart
        </Button>
        <Button size="xs" variant="ghost" onPress={logs} disabled={busy}>
          Logs
        </Button>
        <Button size="xs" variant="ghost" onPress={remove} disabled={busy}>
          Remove
        </Button>
      </View>
    </View>
  );
}

function ImageRow({ image }: { image: DockerImage }) {
  return (
    <View style={styles.imageRow}>
      <Text style={styles.imageName} numberOfLines={1}>
        {image.repository}:{image.tag}
      </Text>
      <Text style={styles.imageMeta} numberOfLines={1}>
        {image.size} · {image.createdSince}
      </Text>
    </View>
  );
}

export function DockerScreen() {
  const serverId = useHostRouteServerId() ?? "";
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const toast = useToast();
  const [logs, setLogs] = useState<{ container: string; text: string } | null>(null);

  const query = useFetchQuery({
    queryKey: ["docker", serverId],
    queryFn: async () => {
      if (!client) throw new Error("Host is offline");
      return client.dockerList();
    },
    enabled: Boolean(client && connected),
    dataShape: "value",
    staleTimeMs: 2_000,
  });

  const action = useMutation({
    mutationFn: async (input: { container: string; action: DockerAction }) => {
      if (!client) throw new Error("Host is offline");
      const result = await client.dockerAction(input);
      if (result.error) throw new Error(result.error);
    },
    onSuccess: () => {
      void query.refetch();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });
  const runAction = action.mutate;

  const openLogs = useCallback(
    async (container: string) => {
      if (!client) return;
      setLogs({ container, text: "Loading logs…" });
      try {
        const result = await client.dockerLogs({ container, tail: 300 });
        setLogs({ container, text: result.error ? `Error: ${result.error}` : result.logs });
      } catch (error) {
        setLogs({ container, text: error instanceof Error ? error.message : String(error) });
      }
    },
    [client],
  );
  const closeLogs = useCallback(() => setLogs(null), []);
  const refresh = useCallback(() => {
    void query.refetch();
  }, [query]);

  const payload = query.data;
  const containers = payload?.containers ?? [];
  const images = payload?.images ?? [];

  return (
    <View style={styles.screen}>
      <BackHeader title="Docker" />
      <ScrollView contentContainerStyle={styles.body}>
        {!connected ? <Alert variant="warning" title="Connect to a host to see Docker." /> : null}
        {connected && payload && !payload.available ? (
          <Alert
            variant="warning"
            title="Docker not detected on this host"
            description="Install Docker and start the daemon; the team's containers will show here."
          />
        ) : null}
        <View style={styles.sectionHead}>
          <Text style={styles.sectionTitle}>CONTAINERS · {containers.length}</Text>
          <Button size="xs" variant="ghost" onPress={refresh}>
            Refresh
          </Button>
        </View>
        {containers.length === 0 ? (
          <Text style={styles.empty}>No containers yet.</Text>
        ) : (
          containers.map((c) => (
            <ContainerRow
              key={c.id}
              container={c}
              onAction={runAction}
              onLogs={openLogs}
              busy={action.isPending}
            />
          ))
        )}
        {logs ? (
          <View style={styles.logsPanel}>
            <View style={styles.logsHead}>
              <Text style={styles.logsTitle}>logs · {logs.container.slice(0, 12)}</Text>
              <Button size="xs" variant="ghost" onPress={closeLogs}>
                Close
              </Button>
            </View>
            <ScrollView style={styles.logsScroll} horizontal>
              <Text style={styles.logsText}>{logs.text}</Text>
            </ScrollView>
          </View>
        ) : null}
        <Text style={styles.sectionTitle}>IMAGES · {images.length}</Text>
        {images.length === 0 ? (
          <Text style={styles.empty}>No images.</Text>
        ) : (
          images.map((img) => <ImageRow key={img.id + img.repository + img.tag} image={img} />)
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  body: { padding: theme.spacing[3], gap: theme.spacing[2] },
  sectionHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sectionTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[2],
  },
  empty: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  row: {
    gap: theme.spacing[1],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  rowHead: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotOn: { backgroundColor: theme.colors.statusSuccess },
  dotOff: { backgroundColor: theme.colors.foregroundMuted },
  name: { color: theme.colors.foreground, fontSize: theme.fontSize.base, flex: 1 },
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  status: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
    marginTop: theme.spacing[1],
  },
  imageRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: theme.spacing[1.5],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  imageName: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, flex: 1 },
  imageMeta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  logsPanel: {
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  logsHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: theme.spacing[2],
  },
  logsTitle: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  logsScroll: { maxHeight: 260, padding: theme.spacing[2] },
  logsText: { color: theme.colors.foreground, fontSize: 11, fontFamily: "monospace" },
}));
