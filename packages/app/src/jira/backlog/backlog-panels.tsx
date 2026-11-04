import { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { JiraEpic, JiraVersion } from "@jagentdesk/protocol/jira/rpc-schemas";
import type { Theme } from "@/styles/theme";
import { KeyedChip } from "../board/keyed";
import { Chip } from "../ui/primitives";
import { jiraStyles } from "../ui/styles";

// The Epic and Version panels of the backlog (spec 29.3). Picking an epic filters the rows to its
// issues; versions are listed with their release state.

export type BacklogPanel = "none" | "epics" | "versions";

export function EpicPanel({
  epics,
  selectedKey,
  onSelect,
}: {
  epics: JiraEpic[];
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
}) {
  const showAll = useCallback(() => onSelect(null), [onSelect]);
  const toggle = useCallback(
    (key: string) => onSelect(selectedKey === key ? null : key),
    [onSelect, selectedKey],
  );
  return (
    <View style={styles.panel} testID="jira-epic-panel">
      <Text style={jiraStyles.sectionLabel}>Epics</Text>
      {epics.length === 0 ? (
        <Text style={jiraStyles.textMuted}>This board has no epics.</Text>
      ) : null}
      <View style={jiraStyles.rowWrap}>
        <Chip label="All issues" active={selectedKey === null} onPress={showAll} />
        {epics.map((epic) => (
          <KeyedChip
            key={epic.key}
            value={epic.key}
            label={`${epic.name}${epic.done ? " (done)" : ""}`}
            active={selectedKey === epic.key}
            onToggle={toggle}
            testID={`jira-epic-${epic.key}`}
          />
        ))}
      </View>
    </View>
  );
}

export function VersionPanel({ versions }: { versions: JiraVersion[] }) {
  return (
    <View style={styles.panel} testID="jira-version-panel">
      <Text style={jiraStyles.sectionLabel}>Versions</Text>
      {versions.length === 0 ? (
        <Text style={jiraStyles.textMuted}>This board has no versions.</Text>
      ) : null}
      {versions.map((version) => (
        <View key={version.id} style={jiraStyles.row}>
          <Text style={jiraStyles.textStrong}>{version.name}</Text>
          <Text style={jiraStyles.textSmall}>
            {version.released ? "Released" : "Unreleased"}
            {version.releaseDate ? ` · ${version.releaseDate}` : ""}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  panel: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
}));
