import { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import type { JiraConnection } from "@jagentdesk/protocol/jira/rpc-schemas";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/utils/confirm-dialog";
import { errorMessage, useJiraCall } from "../api";
import { jiraKeys, useJiraConnections } from "../queries";
import { EmptyState, ErrorBanner, UserAvatar } from "../ui/primitives";
import { jiraStyles } from "../ui/styles";
import { AddConnectionSheet } from "./add-connection-sheet";

// Jira connections (spec 29.1/29.2): one per site, with its account and auth state.

const METHOD_LABEL: Record<JiraConnection["method"], string> = {
  api_token: "API token",
  oauth: "OAuth",
  pat: "Personal access token",
};

const STATE_LABEL: Record<JiraConnection["authState"], string> = {
  connected: "Connected",
  needs_reauth: "Sign in again",
  error: "Error",
};

function describe(connection: JiraConnection): string {
  const deployment = connection.deployment === "cloud" ? "Cloud" : "Data Center";
  return `${connection.siteUrl} · ${deployment} · ${METHOD_LABEL[connection.method]} · ${connection.account.displayName}`;
}

function ConnectionRow({
  serverId,
  connection,
  last,
  onOpen,
}: {
  serverId: string;
  connection: JiraConnection;
  last: boolean;
  onOpen: (connectionId: string) => void;
}) {
  const call = useJiraCall(serverId);
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<"test" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (action: "test" | "remove") => {
      setPending(action);
      setError(null);
      try {
        if (action === "test") {
          await call("jira.connections.test.request", { connectionId: connection.id });
        } else {
          await call("jira.connections.remove.request", { connectionId: connection.id });
        }
        await queryClient.invalidateQueries({ queryKey: jiraKeys.connections(serverId) });
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setPending(null);
      }
    },
    [call, connection.id, queryClient, serverId],
  );
  const open = useCallback(() => onOpen(connection.id), [connection.id, onOpen]);
  const test = useCallback(() => void run("test"), [run]);
  const remove = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: "Remove Jira connection",
      message: `Remove ${connection.label}? Its token is deleted from the host.`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (confirmed) await run("remove");
  }, [connection.label, run]);
  const handleRemove = useCallback(() => void remove(), [remove]);

  return (
    <View
      style={last ? jiraStyles.listRowLast : jiraStyles.listRow}
      testID={`jira-connection-${connection.id}`}
    >
      <UserAvatar user={connection.account} size={28} />
      <View style={jiraStyles.main}>
        <Text style={jiraStyles.textStrong} numberOfLines={1}>
          {connection.label}
        </Text>
        <Text style={jiraStyles.textSmall} numberOfLines={1}>
          {describe(connection)}
        </Text>
        <Text style={jiraStyles.textSmall}>
          {connection.lastError ?? STATE_LABEL[connection.authState]}
        </Text>
        {error ? <ErrorBanner message={error} /> : null}
      </View>
      <Button size="sm" variant="ghost" onPress={open}>
        Open
      </Button>
      <Button size="sm" variant="outline" loading={pending === "test"} onPress={test}>
        Test
      </Button>
      <Button
        size="sm"
        variant="ghost"
        loading={pending === "remove"}
        onPress={handleRemove}
        testID={`jira-connection-remove-${connection.id}`}
      >
        Remove
      </Button>
    </View>
  );
}

export function ConnectionsView({
  serverId,
  onOpen,
}: {
  serverId: string;
  onOpen: (connectionId: string) => void;
}) {
  const connections = useJiraConnections(serverId);
  const [adding, setAdding] = useState(false);
  const list = connections.data ?? [];
  const startAdding = useCallback(() => setAdding(true), []);
  const stopAdding = useCallback(() => setAdding(false), []);
  const added = useCallback(
    (connection: JiraConnection) => {
      setAdding(false);
      onOpen(connection.id);
    },
    [onOpen],
  );
  const emptyAction = useMemo(
    () => (
      <Button variant="default" onPress={startAdding} testID="jira-add-connection-empty">
        Add connection
      </Button>
    ),
    [startAdding],
  );
  const empty = list.length === 0 && !connections.isLoading;
  return (
    <ScrollView
      style={jiraStyles.scroll}
      contentContainerStyle={jiraStyles.scrollContent}
      testID="jira-connections"
    >
      <View style={jiraStyles.row}>
        <Text style={jiraStyles.title}>Connections</Text>
        <View style={jiraStyles.spacer} />
        <Button variant="default" size="sm" onPress={startAdding} testID="jira-add-connection-open">
          Add connection
        </Button>
      </View>
      {connections.error ? <ErrorBanner message={errorMessage(connections.error)} /> : null}
      {empty ? (
        <EmptyState
          title="Connect Jira"
          body="Sign in to Jira Cloud with an API token or OAuth, or to Jira Data Center with a personal access token. Requests and tokens stay on this host."
          action={emptyAction}
        />
      ) : (
        <View style={jiraStyles.card}>
          {list.map((connection, index) => (
            <ConnectionRow
              key={connection.id}
              serverId={serverId}
              connection={connection}
              last={index === list.length - 1}
              onOpen={onOpen}
            />
          ))}
        </View>
      )}
      <AddConnectionSheet
        serverId={serverId}
        visible={adding}
        onClose={stopAdding}
        onAdded={added}
      />
    </ScrollView>
  );
}
