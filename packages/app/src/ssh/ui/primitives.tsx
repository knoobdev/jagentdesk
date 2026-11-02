import { useCallback, type ComponentType } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  KeyRound,
  Pencil,
  Play,
  Search,
  Square,
  Trash2,
} from "lucide-react-native";
import type { Theme } from "@/styles/theme";
import type { SshDotTone } from "@/ssh/use-ssh-connect-events";
import { sshStyles as styles } from "./styles";

// Small building blocks shared by the Servers screens (spec 25.13).

export type IconComponent = ComponentType<{
  size?: number;
  uniProps?: (theme: Theme) => object;
}>;

export const ThemedArrowLeft = withUnistyles(ArrowLeft);
export const ThemedArrowUp = withUnistyles(ArrowUp);
export const ThemedArrowDown = withUnistyles(ArrowDown);
export const ThemedChevronDown = withUnistyles(ChevronDown);
export const ThemedChevronRight = withUnistyles(ChevronRight);
export const ThemedCircleAlert = withUnistyles(CircleAlert);
export const ThemedCopy = withUnistyles(Copy);
export const ThemedKeyRound = withUnistyles(KeyRound);
export const ThemedPencil = withUnistyles(Pencil);
export const ThemedPlay = withUnistyles(Play);
export const ThemedSearch = withUnistyles(Search);
export const ThemedSquare = withUnistyles(Square);
export const ThemedTrash = withUnistyles(Trash2);
export const ThemedTextInput = withUnistyles(TextInput);

export const fgTint = (theme: Theme) => ({ color: theme.colors.foreground });
export const mutedTint = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
export const redTint = (theme: Theme) => ({ color: theme.colors.palette.red[500] });

export function IconBtn({
  icon: Icon,
  tint,
  label,
  onPress,
  disabled,
  testID,
}: {
  icon: IconComponent;
  tint: (theme: Theme) => object;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      style={[styles.iconBtn, disabled ? styles.btnDisabled : null]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
    >
      <Icon size={15} uniProps={tint} />
    </Pressable>
  );
}

const DOT_STYLE: Record<SshDotTone, "dotGreen" | "dotYellow" | "dotRed" | "dotMuted"> = {
  green: "dotGreen",
  yellow: "dotYellow",
  red: "dotRed",
  muted: "dotMuted",
};

/** Tab/row status dot: green connected, yellow waiting for input, red error or lost (25.4). */
export function StateDot({ tone }: { tone: SshDotTone }) {
  return <View style={[styles.dot, styles[DOT_STYLE[tone]]]} />;
}

export function TabButton<T extends string>({
  label,
  value,
  active,
  onSelect,
  testID,
}: {
  label: string;
  value: T;
  active: boolean;
  onSelect: (value: T) => void;
  testID?: string;
}) {
  const handlePress = useCallback(() => onSelect(value), [onSelect, value]);
  return (
    <Pressable style={active ? styles.tabActive : styles.tab} onPress={handlePress} testID={testID}>
      <Text style={active ? styles.tabTextActive : styles.tabText}>{label}</Text>
    </Pressable>
  );
}

/** A selectable pill (tags, auth methods, jump hosts). */
export function Chip<T>({
  label,
  value,
  active,
  onToggle,
  testID,
  accessibilityLabel,
}: {
  label: string;
  value: T;
  active: boolean;
  onToggle: (value: T) => void;
  testID?: string;
  accessibilityLabel?: string;
}) {
  const handlePress = useCallback(() => onToggle(value), [onToggle, value]);
  return (
    <Pressable
      style={active ? styles.tagChipActive : styles.tagChip}
      onPress={handlePress}
      testID={testID}
      accessibilityLabel={accessibilityLabel}
    >
      <Text style={active ? styles.tagTextActive : styles.tagText}>{label}</Text>
    </Pressable>
  );
}

/** Collapsible section header in forms. */
export function Disclosure({
  title,
  open,
  onToggle,
  testID,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  testID?: string;
}) {
  return (
    <Pressable style={styles.disclosureRow} onPress={onToggle} testID={testID}>
      {open ? (
        <ThemedChevronDown size={15} uniProps={mutedTint} />
      ) : (
        <ThemedChevronRight size={15} uniProps={mutedTint} />
      )}
      <Text style={styles.disclosureTitle}>{title}</Text>
    </Pressable>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <View style={styles.errorBanner}>
      <ThemedCircleAlert size={16} uniProps={redTint} />
      <Text style={styles.errorText}>{message}</Text>
    </View>
  );
}
