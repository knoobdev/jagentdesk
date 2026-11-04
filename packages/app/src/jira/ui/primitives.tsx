import { useCallback, useMemo, type ComponentType, type ReactNode } from "react";
import { Pressable, Text, TextInput, View, type TextInputProps } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  Bookmark,
  Bug,
  ChevronDown,
  ChevronsDown,
  ChevronsUp,
  ChevronUp,
  CircleAlert,
  Equal,
  Flag,
  SquareCheck,
  Zap,
  GitBranch,
} from "lucide-react-native";
import type {
  JiraIssueType,
  JiraPriority,
  JiraStatus,
  JiraUser,
} from "@jagentdesk/protocol/jira/rpc-schemas";
import type { Theme } from "@/styles/theme";
import { jiraStyles } from "./styles";

// Small visual building blocks of the Jira surface. Users render as initials and issue types /
// priorities as icons chosen by name: no Jira avatar or icon URL ever reaches the app (ADR-0034).

export type ThemedIcon = ComponentType<{ size?: number; uniProps?: (theme: Theme) => object }>;

export const tint = {
  fg: (theme: Theme) => ({ color: theme.colors.foreground }),
  muted: (theme: Theme) => ({ color: theme.colors.foregroundMuted }),
  red: (theme: Theme) => ({ color: theme.colors.palette.red[500] }),
  orange: (theme: Theme) => ({ color: theme.colors.palette.orange[500] }),
  amber: (theme: Theme) => ({ color: theme.colors.palette.amber[500] }),
  blue: (theme: Theme) => ({ color: theme.colors.palette.blue[500] }),
  green: (theme: Theme) => ({ color: theme.colors.palette.green[500] }),
  purple: (theme: Theme) => ({ color: theme.colors.palette.purple[500] }),
};

const ThemedBug = withUnistyles(Bug);
const ThemedBookmark = withUnistyles(Bookmark);
const ThemedSquareCheck = withUnistyles(SquareCheck);
const ThemedZap = withUnistyles(Zap);
const ThemedGitBranch = withUnistyles(GitBranch);
const ThemedChevronsUp = withUnistyles(ChevronsUp);
const ThemedChevronUp = withUnistyles(ChevronUp);
const ThemedEqual = withUnistyles(Equal);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronsDown = withUnistyles(ChevronsDown);
const ThemedFlag = withUnistyles(Flag);
const ThemedCircleAlert = withUnistyles(CircleAlert);

export function IssueTypeIcon({
  type,
  size = 14,
}: {
  type: Pick<JiraIssueType, "name" | "subtask">;
  size?: number;
}) {
  const name = type.name.toLowerCase();
  if (type.subtask) return <ThemedGitBranch size={size} uniProps={tint.blue} />;
  if (name.includes("bug")) return <ThemedBug size={size} uniProps={tint.red} />;
  if (name.includes("epic")) return <ThemedZap size={size} uniProps={tint.purple} />;
  if (name.includes("story")) return <ThemedBookmark size={size} uniProps={tint.green} />;
  return <ThemedSquareCheck size={size} uniProps={tint.blue} />;
}

export function PriorityIcon({
  priority,
  size = 14,
}: {
  priority: JiraPriority | null;
  size?: number;
}) {
  if (!priority) return null;
  const name = priority.name.toLowerCase();
  if (name.includes("highest") || name.includes("blocker"))
    return <ThemedChevronsUp size={size} uniProps={tint.red} />;
  if (name.includes("high") || name.includes("critical") || name.includes("major")) {
    return <ThemedChevronUp size={size} uniProps={tint.orange} />;
  }
  if (name.includes("lowest") || name.includes("trivial"))
    return <ThemedChevronsDown size={size} uniProps={tint.blue} />;
  if (name.includes("low") || name.includes("minor"))
    return <ThemedChevronDown size={size} uniProps={tint.blue} />;
  return <ThemedEqual size={size} uniProps={tint.amber} />;
}

export function FlagIcon({ size = 12 }: { size?: number }) {
  return <ThemedFlag size={size} uniProps={tint.red} />;
}

const LOZENGE_STYLE = {
  new: "lozengeNew",
  indeterminate: "lozengeProgress",
  done: "lozengeDone",
  undefined: "lozengeNew",
} as const;
const LOZENGE_TEXT = {
  new: "lozengeTextNew",
  indeterminate: "lozengeTextProgress",
  done: "lozengeTextDone",
  undefined: "lozengeTextNew",
} as const;

export function StatusLozenge({ status, testID }: { status: JiraStatus; testID?: string }) {
  return (
    <View style={styles[LOZENGE_STYLE[status.category]]} testID={testID}>
      <Text style={styles[LOZENGE_TEXT[status.category]]} numberOfLines={1}>
        {status.name.toUpperCase()}
      </Text>
    </View>
  );
}

const AVATAR_TONES = [
  "avatarBlue",
  "avatarGreen",
  "avatarPurple",
  "avatarOrange",
  "avatarAmber",
] as const;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    parts.length > 1
      ? `${parts[0]?.[0] ?? ""}${parts.at(-1)?.[0] ?? ""}`
      : (parts[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

function toneFor(ref: string): (typeof AVATAR_TONES)[number] {
  let hash = 0;
  for (const char of ref) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_TONES[hash % AVATAR_TONES.length] ?? "avatarBlue";
}

export function UserAvatar({ user, size = 24 }: { user: JiraUser | null; size?: number }) {
  const box = { width: size, height: size, borderRadius: size / 2 };
  if (!user) {
    return (
      <View style={[styles.avatarEmpty, box]} accessibilityLabel="Unassigned">
        <Text style={[styles.avatarText, { fontSize: size * 0.42 }]}>?</Text>
      </View>
    );
  }
  return (
    <View style={[styles[toneFor(user.ref)], box]} accessibilityLabel={user.displayName}>
      <Text style={[styles.avatarText, { fontSize: size * 0.42 }]}>
        {initials(user.displayName)}
      </Text>
    </View>
  );
}

export function ErrorBanner({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <View style={jiraStyles.errorBanner} testID="jira-error">
      <ThemedCircleAlert size={16} uniProps={tint.red} />
      <Text style={jiraStyles.errorText}>{message}</Text>
      {action}
    </View>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <View style={jiraStyles.empty}>
      <Text style={jiraStyles.textStrong}>{title}</Text>
      {body ? <Text style={[jiraStyles.textMuted, styles.center]}>{body}</Text> : null}
      {action}
    </View>
  );
}

export function Chip({
  label,
  active,
  onPress,
  testID,
  leading,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  testID?: string;
  leading?: ReactNode;
}) {
  const state = useMemo(() => ({ selected: active }), [active]);
  return (
    <Pressable
      style={active ? jiraStyles.chipActive : jiraStyles.chip}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={state}
      testID={testID}
    >
      {leading}
      <Text style={active ? jiraStyles.chipTextActive : jiraStyles.chipText}>{label}</Text>
    </Pressable>
  );
}

function TabButton<T extends string>({
  id,
  label,
  selected,
  onPick,
  testID,
}: {
  id: T;
  label: string;
  selected: boolean;
  onPick: (id: T) => void;
  testID: string;
}) {
  const press = useCallback(() => onPick(id), [id, onPick]);
  const state = useMemo(() => ({ selected }), [selected]);
  return (
    <Pressable
      style={selected ? jiraStyles.tabActive : jiraStyles.tab}
      onPress={press}
      accessibilityRole="tab"
      accessibilityState={state}
      testID={testID}
    >
      <Text style={selected ? jiraStyles.tabTextActive : jiraStyles.tabText}>{label}</Text>
    </Pressable>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  testIDPrefix,
}: {
  tabs: ReadonlyArray<{ id: T; label: string }>;
  value: T;
  onChange: (id: T) => void;
  testIDPrefix: string;
}) {
  return (
    <View style={jiraStyles.tabRow} accessibilityRole="tablist">
      {tabs.map((tab) => (
        <TabButton
          key={tab.id}
          id={tab.id}
          label={tab.label}
          selected={tab.id === value}
          onPick={onChange}
          testID={`${testIDPrefix}-${tab.id}`}
        />
      ))}
    </View>
  );
}

/** A list row that reports its value, so lists pass one stable handler instead of closures. */
export function PressableRow<T extends string | number>({
  value,
  onPick,
  last,
  testID,
  disabled,
  children,
}: {
  value: T;
  onPick: (value: T) => void;
  last: boolean;
  testID?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  const press = useCallback(() => onPick(value), [onPick, value]);
  return (
    <Pressable
      style={last ? jiraStyles.listRowLast : jiraStyles.listRow}
      onPress={press}
      disabled={disabled}
      accessibilityRole="button"
      testID={testID}
    >
      {children}
    </Pressable>
  );
}

const ThemedTextInput = withUnistyles(TextInput);
const placeholderTint = (theme: Theme) => ({ placeholderTextColor: theme.colors.foregroundMuted });

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={jiraStyles.formField}>
      <Text style={jiraStyles.formLabel}>{label}</Text>
      {children}
    </View>
  );
}

export function Input(props: TextInputProps & { multiline?: boolean }) {
  return (
    <ThemedTextInput
      {...props}
      style={[props.multiline ? jiraStyles.inputMultiline : jiraStyles.input, props.style]}
      uniProps={placeholderTint}
      autoCapitalize={props.autoCapitalize ?? "none"}
      autoCorrect={props.autoCorrect ?? false}
    />
  );
}

export function IconButton({
  icon: Icon,
  label,
  onPress,
  testID,
  disabled,
}: {
  icon: ThemedIcon;
  label: string;
  onPress: () => void;
  testID?: string;
  disabled?: boolean;
}) {
  return (
    <Pressable
      style={jiraStyles.iconButton}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
      hitSlop={6}
    >
      <Icon size={16} uniProps={tint.muted} />
    </Pressable>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  center: { textAlign: "center" },
  lozengeNew: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.surface3,
    alignSelf: "flex-start",
  },
  lozengeProgress: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.palette.blue[100],
    alignSelf: "flex-start",
  },
  lozengeDone: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.palette.green[100],
    alignSelf: "flex-start",
  },
  lozengeTextNew: {
    fontSize: 11,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundMuted,
  },
  lozengeTextProgress: {
    fontSize: 11,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.palette.blue[800],
  },
  lozengeTextDone: {
    fontSize: 11,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.palette.green[800],
  },
  avatarEmpty: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface3,
  },
  avatarBlue: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.palette.blue[600],
  },
  avatarGreen: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.palette.green[600],
  },
  avatarPurple: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.palette.purple[600],
  },
  avatarOrange: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.palette.orange[600],
  },
  avatarAmber: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.palette.amber[700],
  },
  avatarText: { color: theme.colors.palette.white, fontWeight: theme.fontWeight.semibold },
}));
