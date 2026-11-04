import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Plus, Trash2 } from "lucide-react-native";
import type {
  JiraSwimlaneConfig,
  JiraSwimlaneMode,
  JiraSwimlaneQuery,
} from "@jagentdesk/protocol/jira/rpc-schemas";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import type { Theme } from "@/styles/theme";
import { useJiraCall } from "../api";
import { useJiraInvalidate } from "../queries";
import { ErrorBanner, Field, IconButton, Input } from "../ui/primitives";
import { jiraStyles } from "../ui/styles";
import { KeyedChip } from "./keyed";
import { useAction } from "./use-action";

// Swimlanes (spec 29.3): Jira has no swimlane API, so the user picks None / Assignee /
// Epic or Parent / Queries here and the daemon keeps it per board in swimlanes.json.

const ThemedTrash = withUnistyles(Trash2);

const MODES: ReadonlyArray<{ id: JiraSwimlaneMode; label: string }> = [
  { id: "none", label: "None" },
  { id: "assignee", label: "Assignee" },
  { id: "epic", label: "Epic / Parent" },
  { id: "queries", label: "Queries" },
];

function newQuery(index: number): JiraSwimlaneQuery {
  return { id: `q${Date.now().toString(36)}${index}`, name: "", jql: "" };
}

function QueryEditor({
  query,
  index,
  onChange,
  onRemove,
}: {
  query: JiraSwimlaneQuery;
  index: number;
  onChange: (id: string, patch: Partial<JiraSwimlaneQuery>) => void;
  onRemove: (id: string) => void;
}) {
  const remove = useCallback(() => onRemove(query.id), [onRemove, query.id]);
  const setName = useCallback((name: string) => onChange(query.id, { name }), [onChange, query.id]);
  const setJql = useCallback((jql: string) => onChange(query.id, { jql }), [onChange, query.id]);
  return (
    <View style={jiraStyles.card}>
      <View style={styles.laneBody}>
        <View style={jiraStyles.row}>
          <Text style={[jiraStyles.textStrong, jiraStyles.spacer]}>Lane {index + 1}</Text>
          <IconButton icon={ThemedTrash} label="Remove lane" onPress={remove} />
        </View>
        <Field label="Name">
          <Input
            value={query.name}
            onChangeText={setName}
            testID={`jira-swimlane-query-name-${index}`}
          />
        </Field>
        <Field label="JQL">
          <Input
            value={query.jql}
            onChangeText={setJql}
            placeholder="priority = Highest OR labels = urgent"
            testID={`jira-swimlane-query-jql-${index}`}
          />
        </Field>
      </View>
    </View>
  );
}

export function SwimlaneSheet({
  serverId,
  connectionId,
  boardId,
  current,
  onClose,
}: {
  serverId: string;
  connectionId: string;
  boardId: number;
  current: JiraSwimlaneConfig;
  onClose: () => void;
}) {
  const call = useJiraCall(serverId);
  const invalidate = useJiraInvalidate(serverId, connectionId);
  const { run, pending, error } = useAction();
  const [mode, setMode] = useState<JiraSwimlaneMode>(current.mode);
  const [queries, setQueries] = useState<JiraSwimlaneQuery[]>(
    current.queries.length > 0 ? current.queries : [newQuery(0)],
  );
  const header = useMemo(() => ({ title: "Swimlanes" }), []);
  const complete = useMemo(
    () => queries.filter((query) => query.name.trim() && query.jql.trim()),
    [queries],
  );
  const invalid = mode === "queries" && complete.length === 0;

  const update = useCallback(
    (id: string, patch: Partial<JiraSwimlaneQuery>) =>
      setQueries((list) => list.map((query) => (query.id === id ? { ...query, ...patch } : query))),
    [],
  );
  const remove = useCallback(
    (id: string) => setQueries((list) => list.filter((query) => query.id !== id)),
    [],
  );
  const add = useCallback(() => setQueries((list) => [...list, newQuery(list.length)]), []);

  const save = useCallback(async () => {
    const ok = await run(async () => {
      await call("jira.swimlanes.set.request", {
        connectionId,
        boardId,
        swimlanes: { mode, queries: mode === "queries" ? complete : current.queries },
      });
      await invalidate();
    });
    if (ok) onClose();
  }, [boardId, call, complete, connectionId, current.queries, invalidate, mode, onClose, run]);
  const handleSave = useCallback(() => void save(), [save]);

  const footer = useMemo(
    () => (
      <View style={jiraStyles.sheetFooter}>
        <Button variant="ghost" onPress={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button
          variant="default"
          onPress={handleSave}
          loading={pending}
          disabled={invalid}
          testID="jira-swimlanes-save"
        >
          Save
        </Button>
      </View>
    ),
    [handleSave, invalid, onClose, pending],
  );

  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      header={header}
      footer={footer}
      testID="jira-swimlane-sheet"
    >
      <View style={jiraStyles.sheetBody}>
        {error ? <ErrorBanner message={error} /> : null}
        <Text style={jiraStyles.textMuted}>
          Jira does not share board swimlanes with apps; this choice is kept for this board in
          JAgentDesk.
        </Text>
        <View style={jiraStyles.rowWrap}>
          {MODES.map((entry) => (
            <KeyedChip
              key={entry.id}
              value={entry.id}
              label={entry.label}
              active={mode === entry.id}
              onToggle={setMode}
              testID={`jira-swimlane-mode-${entry.id}`}
            />
          ))}
        </View>
        {mode === "queries" ? (
          <View style={jiraStyles.sheetBody}>
            <Text style={jiraStyles.textMuted}>
              An issue goes to the first lane whose JQL it matches; the rest go to Everything else.
            </Text>
            {queries.map((query, index) => (
              <QueryEditor
                key={query.id}
                query={query}
                index={index}
                onChange={update}
                onRemove={remove}
              />
            ))}
            <Button variant="outline" leftIcon={Plus} onPress={add}>
              Add lane
            </Button>
          </View>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  laneBody: { gap: theme.spacing[2], padding: theme.spacing[3] },
}));
