import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { JiraUser } from "@jagentdesk/protocol/jira/rpc-schemas";
import { errorMessage, useJiraCall } from "../api";
import { ErrorBanner, Input, UserAvatar } from "../ui/primitives";
import { jiraStyles } from "../ui/styles";
import { ValueRow, Spinner } from "./controls";

const SEARCH_DELAY_MS = 250;

// Search people on the Jira site (assignable to the issue when one is given).
export function UserPicker({
  serverId,
  connectionId,
  issueKey,
  onPick,
  testID,
}: {
  serverId: string;
  connectionId: string;
  issueKey: string;
  onPick: (user: JiraUser) => void;
  testID?: string;
}) {
  const call = useJiraCall(serverId);
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<JiraUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (query.trim().length === 0) {
      setUsers([]);
      return;
    }
    let cancelled = false;
    const search = async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await call("jira.users.find.request", {
          connectionId,
          query: query.trim(),
          issueKey,
        });
        if (!cancelled) setUsers(result.users);
      } catch (caught) {
        if (!cancelled) setError(errorMessage(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    const timer = setTimeout(() => void search(), SEARCH_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [call, connectionId, issueKey, query]);

  return (
    <View style={jiraStyles.sheetBody}>
      <Input
        value={query}
        onChangeText={setQuery}
        placeholder="Search people"
        autoFocus
        testID={testID ? `${testID}-search` : undefined}
      />
      {loading ? <Spinner /> : null}
      {error ? <ErrorBanner message={error} /> : null}
      {users.map((user) => (
        <ValueRow
          key={user.ref}
          value={user}
          onSelect={onPick}
          accessibilityLabel={user.displayName}
          testID={testID ? `${testID}-option-${user.ref}` : undefined}
        >
          <UserAvatar user={user} size={22} />
          <Text style={jiraStyles.text}>{user.displayName}</Text>
        </ValueRow>
      ))}
    </View>
  );
}
