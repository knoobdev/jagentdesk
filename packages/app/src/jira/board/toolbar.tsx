import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Rows3, Search } from "lucide-react-native";
import type {
  JiraBoardConfiguration,
  JiraSprint,
  JiraSwimlaneMode,
  JiraUser,
} from "@jagentdesk/protocol/jira/rpc-schemas";
import { Button } from "@/components/ui/button";
import type { Theme } from "@/styles/theme";
import { Input, tint, UserAvatar } from "../ui/primitives";
import { KeyedChip } from "./keyed";
import { jiraStyles } from "../ui/styles";

// Board header (spec 29.3): name, active sprint with days left and Complete sprint, quick filters
// (Cloud), search, assignee filter, swimlane picker, and the way to the backlog.

const ThemedSearch = withUnistyles(Search);

const DAY_MS = 86_400_000;

const SWIMLANE_LABEL: Record<JiraSwimlaneMode, string> = {
  none: "No swimlanes",
  assignee: "Assignee",
  epic: "Epic / Parent",
  queries: "Queries",
};

export function daysRemaining(sprint: JiraSprint, now: number): string | null {
  if (sprint.endDate_ms === null) return null;
  const days = Math.ceil((sprint.endDate_ms - now) / DAY_MS);
  if (days < 0) return "Ended";
  return days === 1 ? "1 day left" : `${days} days left`;
}

export interface BoardFilterState {
  quickFilterIds: number[];
  text: string;
  assigneeRefs: string[];
}

function AssigneeToggle({
  user,
  active,
  onToggle,
}: {
  user: JiraUser;
  active: boolean;
  onToggle: (ref: string) => void;
}) {
  const handlePress = useCallback(() => onToggle(user.ref), [onToggle, user.ref]);
  const state = useMemo(() => ({ selected: active }), [active]);
  return (
    <Pressable
      onPress={handlePress}
      style={active ? styles.avatarActive : styles.avatar}
      accessibilityRole="button"
      accessibilityLabel={`Only ${user.displayName}`}
      accessibilityState={state}
      testID={`jira-board-assignee-${user.ref}`}
    >
      <UserAvatar user={user} size={26} />
    </Pressable>
  );
}

function toggled<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export function BoardToolbar({
  configuration,
  sprint,
  assignees,
  filter,
  swimlaneMode,
  onFilterChange,
  onCompleteSprint,
  onSwimlanes,
}: {
  configuration: JiraBoardConfiguration;
  sprint: JiraSprint | null;
  assignees: JiraUser[];
  filter: BoardFilterState;
  swimlaneMode: JiraSwimlaneMode;
  onFilterChange: (next: BoardFilterState) => void;
  onCompleteSprint: () => void;
  onSwimlanes: () => void;
}) {
  const remaining = sprint ? daysRemaining(sprint, Date.now()) : null;
  const toggleQuick = useCallback(
    (id: number) =>
      onFilterChange({ ...filter, quickFilterIds: toggled(filter.quickFilterIds, id) }),
    [filter, onFilterChange],
  );
  const toggleAssignee = useCallback(
    (ref: string) => onFilterChange({ ...filter, assigneeRefs: toggled(filter.assigneeRefs, ref) }),
    [filter, onFilterChange],
  );
  const setText = useCallback(
    (text: string) => onFilterChange({ ...filter, text }),
    [filter, onFilterChange],
  );
  return (
    <View style={styles.container}>
      <View style={jiraStyles.rowWrap}>
        <View style={styles.titleBlock}>
          <Text style={jiraStyles.title} numberOfLines={1}>
            {sprint ? sprint.name : configuration.name}
          </Text>
          {sprint?.goal ? (
            <Text style={jiraStyles.textMuted} numberOfLines={1}>
              {sprint.goal}
            </Text>
          ) : null}
        </View>
        {remaining ? <Text style={jiraStyles.textMuted}>{remaining}</Text> : null}
        <View style={jiraStyles.spacer} />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={Rows3}
          onPress={onSwimlanes}
          testID="jira-swimlane-picker"
        >
          {SWIMLANE_LABEL[swimlaneMode]}
        </Button>
        {sprint ? (
          <Button
            variant="secondary"
            size="sm"
            onPress={onCompleteSprint}
            testID="jira-board-complete-sprint"
          >
            Complete sprint
          </Button>
        ) : null}
      </View>
      <View style={jiraStyles.rowWrap}>
        <View style={styles.search}>
          <ThemedSearch size={14} uniProps={tint.muted} />
          <Input
            value={filter.text}
            onChangeText={setText}
            placeholder="Search this board"
            style={styles.searchInput}
            testID="jira-board-search"
          />
        </View>
        {assignees.length > 0 ? (
          <View style={styles.avatars}>
            {assignees.map((user) => (
              <AssigneeToggle
                key={user.ref}
                user={user}
                active={filter.assigneeRefs.includes(user.ref)}
                onToggle={toggleAssignee}
              />
            ))}
          </View>
        ) : null}
        {configuration.quickFilters.map((quick) => (
          <KeyedChip
            key={quick.id}
            value={quick.id}
            label={quick.name}
            active={filter.quickFilterIds.includes(quick.id)}
            onToggle={toggleQuick}
            testID={`jira-quickfilter-${quick.id}`}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  titleBlock: { minWidth: 0, flexShrink: 1 },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingLeft: theme.spacing[2],
    minWidth: 200,
    flexShrink: 1,
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  searchInput: { flex: 1, borderWidth: 0, backgroundColor: theme.colors.surface1 },
  avatars: { flexDirection: "row", gap: 2 },
  avatar: {
    borderRadius: theme.borderRadius.full,
    borderWidth: 2,
    borderColor: theme.colors.surface0,
  },
  avatarActive: {
    borderRadius: theme.borderRadius.full,
    borderWidth: 2,
    borderColor: theme.colors.accent,
  },
}));
