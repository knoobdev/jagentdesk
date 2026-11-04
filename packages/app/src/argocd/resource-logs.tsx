import { useCallback, useEffect, useReducer, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ArgoCdAppRef, ArgoCdLogEntry } from "@jagentdesk/protocol/argocd/rpc-schemas";
import { AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { ArgoCdSpinner } from "./spinner";
import { Switch } from "@/components/ui/switch";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { ArgoCdCheckbox } from "./checkbox";
import type { ArgoCdResourceItem } from "./resources";

const MAX_LOG_LINES = 5000;
const TAIL_CHOICES = [100, 500, 1000] as const;

interface LogOptions {
  follow: boolean;
  tailLines: number;
  filter: string;
  previous: boolean;
}

/** A received line with its arrival number, the stable list key. */
interface LogLine {
  seq: number;
  entry: ArgoCdLogEntry;
}

type LogState =
  | { status: "connecting"; entries: LogLine[] }
  | { status: "streaming"; entries: LogLine[] }
  | { status: "ended"; entries: LogLine[] }
  | { status: "error"; entries: LogLine[]; message: string };

type LogAction =
  | { type: "start" }
  | { type: "chunk"; entries: ArgoCdLogEntry[]; last: boolean; error: string | null }
  | { type: "failed"; message: string };

function reduceLogs(state: LogState, action: LogAction): LogState {
  switch (action.type) {
    case "start":
      return { status: "connecting", entries: [] };
    case "failed":
      return { status: "error", entries: state.entries, message: action.message };
    case "chunk": {
      const firstSeq = (state.entries.at(-1)?.seq ?? 0) + 1;
      const received = action.entries.map((entry, offset) => ({ seq: firstSeq + offset, entry }));
      const entries = [...state.entries, ...received].slice(-MAX_LOG_LINES);
      if (action.error) return { status: "error", entries, message: action.error };
      return { status: action.last ? "ended" : "streaming", entries };
    }
  }
}

let logSubscriptionCounter = 0;

function nextLogSubscriptionId(): string {
  logSubscriptionCounter += 1;
  return `argocd-logs-${Date.now().toString(36)}-${logSubscriptionCounter}`;
}

function statusText(state: LogState, follow: boolean): string {
  switch (state.status) {
    case "connecting":
      return "Connecting...";
    case "streaming":
      return follow ? "Following" : "Loading...";
    case "ended":
      return `${state.entries.length} lines`;
    case "error":
      return state.message;
  }
}

/** Logs tab: a pod's logs, or every pod of a workload, streamed from Argo CD (spec 30.3). */
export function ArgoCdResourceLogs({
  serverId,
  instanceId,
  app,
  item,
}: {
  serverId: string;
  instanceId: string;
  app: ArgoCdAppRef;
  item: ArgoCdResourceItem;
}) {
  const client = useHostRuntimeClient(serverId);
  const [options, setOptions] = useState<LogOptions>({
    follow: true,
    tailLines: TAIL_CHOICES[0],
    filter: "",
    previous: false,
  });
  const [filterDraft, setFilterDraft] = useState("");
  const [state, dispatch] = useReducer(reduceLogs, { status: "connecting", entries: [] });
  const isPod = item.kind === "Pod" && item.group === "";

  useEffect(() => {
    if (!client) return;
    const subscriptionId = nextLogSubscriptionId();
    let active = true;
    dispatch({ type: "start" });
    const off = client.on("argocd.app.logs.chunk", (message) => {
      if (message.payload.subscriptionId !== subscriptionId) return;
      dispatch({
        type: "chunk",
        entries: message.payload.entries,
        last: message.payload.last,
        error: message.payload.error,
      });
    });
    const target = isPod
      ? { podName: item.name }
      : {
          resource: {
            group: item.group,
            kind: item.kind,
            namespace: item.namespace,
            name: item.name,
          },
        };
    client
      .argocd("argocd.app.logs.subscribe.request", {
        instanceId,
        app,
        subscriptionId,
        ...target,
        namespace: item.namespace,
        tailLines: options.tailLines,
        follow: options.follow,
        previous: options.previous,
        ...(options.filter ? { filter: options.filter } : {}),
      })
      .then((payload) => {
        if (active && payload.error) dispatch({ type: "failed", message: payload.error });
        return undefined;
      })
      .catch((error: unknown) => {
        if (!active) return;
        dispatch({
          type: "failed",
          message: error instanceof Error ? error.message : "Unable to load logs",
        });
      });
    return () => {
      active = false;
      off();
      // Best effort: after a disconnect the daemon has already dropped the stream.
      void client
        .argocd("argocd.app.logs.unsubscribe.request", { subscriptionId })
        .catch(() => undefined);
    };
  }, [client, instanceId, app, isPod, item.group, item.kind, item.name, item.namespace, options]);

  const handleFollow = useCallback(
    (follow: boolean) => setOptions((current) => ({ ...current, follow })),
    [],
  );
  const handlePrevious = useCallback(
    (previous: boolean) => setOptions((current) => ({ ...current, previous })),
    [],
  );
  const handleApplyFilter = useCallback(
    () => setOptions((current) => ({ ...current, filter: filterDraft.trim() })),
    [filterDraft],
  );
  const handleTail = useCallback(
    (tailLines: number) => setOptions((current) => ({ ...current, tailLines })),
    [],
  );

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <View style={styles.toggle}>
          <Switch value={options.follow} onValueChange={handleFollow} accessibilityLabel="Follow" />
          <Text style={styles.toolbarLabel}>Follow</Text>
        </View>
        <ArgoCdCheckbox label="Previous" value={options.previous} onValueChange={handlePrevious} />
        <View style={styles.tailGroup}>
          <Text style={styles.toolbarLabel}>Tail</Text>
          {TAIL_CHOICES.map((tail) => (
            <TailButton
              key={tail}
              tail={tail}
              active={options.tailLines === tail}
              onSelect={handleTail}
            />
          ))}
        </View>
      </View>
      <View style={styles.toolbar}>
        <AdaptiveTextInput
          style={styles.filterInput}
          initialValue=""
          onChangeText={setFilterDraft}
          onSubmitEditing={handleApplyFilter}
          placeholder="Filter lines"
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Filter log lines"
        />
        <Button variant="outline" size="xs" onPress={handleApplyFilter}>
          Apply
        </Button>
      </View>
      <View style={styles.statusRow}>
        {state.status === "connecting" ? <ArgoCdSpinner size={12} /> : null}
        <Text
          style={state.status === "error" ? styles.errorText : styles.statusText}
          numberOfLines={2}
        >
          {statusText(state, options.follow)}
        </Text>
      </View>
      <ScrollView style={styles.logScroll} contentContainerStyle={styles.logContent}>
        <ScrollView horizontal>
          <View>
            {state.entries.length === 0 && state.status !== "connecting" ? (
              <Text style={styles.statusText}>No log lines</Text>
            ) : null}
            {state.entries.map(({ seq, entry }) => (
              <Text key={seq} style={styles.logLine} selectable>
                {isPod ? entry.content : `${entry.podName}  ${entry.content}`}
              </Text>
            ))}
          </View>
        </ScrollView>
      </ScrollView>
    </View>
  );
}

function TailButton({
  tail,
  active,
  onSelect,
}: {
  tail: number;
  active: boolean;
  onSelect: (tail: number) => void;
}) {
  const handlePress = useCallback(() => onSelect(tail), [onSelect, tail]);
  return (
    <Button variant={active ? "secondary" : "ghost"} size="xs" onPress={handlePress}>
      {String(tail)}
    </Button>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    gap: theme.spacing[2],
  },
  toolbar: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  toggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  toolbarLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  tailGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  filterInput: {
    flex: 1,
    minWidth: 120,
    height: 28,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    fontSize: theme.fontSize.xs,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  statusText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  errorText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.palette.red[300],
  },
  logScroll: {
    flex: 1,
    minHeight: 160,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  logContent: {
    padding: theme.spacing[2],
  },
  logLine: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foreground,
  },
}));
