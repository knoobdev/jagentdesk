import { ChevronRight } from "lucide-react-native";
import { Children, isValidElement, useCallback, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { isWeb } from "@/constants/platform";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE } from "@/styles/theme";

const ThemedChevronRight = withUnistyles(ChevronRight);

type HoverState = PressableStateCallbackType & { hovered?: boolean };

interface SettingsCollapsibleRowProps {
  label: string;
  /** A short status shown before the chevron, so the row says something while collapsed. */
  summary?: string;
  defaultExpanded?: boolean;
  testID?: string;
  /** The rows revealed underneath, separated like the rows of a `SettingsCard`. */
  children: ReactNode;
}

/**
 * A settings row that folds a group of rows under it. Collapsed, it is one row: the label and a
 * trailing chevron that points right, and turns down once expanded. Sits inside a `SettingsCard`
 * like any other row.
 */
export function SettingsCollapsibleRow({
  label,
  summary,
  defaultExpanded = false,
  testID,
  children,
}: SettingsCollapsibleRowProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  // React Native Web does not map `accessibilityState.expanded` to `aria-expanded`.
  const webExpandedProps = useMemo(
    () => (isWeb ? ({ "aria-expanded": expanded } as const) : null),
    [expanded],
  );
  const headerStyle = useCallback(
    ({ hovered }: HoverState) => [settingsStyles.row, hovered && styles.hovered],
    [],
  );
  const chevronStyle = useMemo(() => (expanded ? styles.chevronExpanded : undefined), [expanded]);

  return (
    <View testID={testID}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={accessibilityState}
        {...webExpandedProps}
        onPress={toggle}
        style={headerStyle}
        testID={testID ? `${testID}-toggle` : undefined}
      >
        <Text style={[settingsStyles.rowTitle, styles.label]}>{label}</Text>
        <View style={styles.trailing}>
          {summary ? (
            <Text style={styles.summary} numberOfLines={1}>
              {summary}
            </Text>
          ) : null}
          <View style={chevronStyle}>
            <ThemedChevronRight size={ICON_SIZE.sm} uniProps={mutedIconColorMapping} />
          </View>
        </View>
      </Pressable>
      {expanded ? (
        <View style={styles.children}>
          {Children.toArray(children).map((child, index) => (
            <View key={isValidElement(child) ? child.key : index} style={settingsStyles.rowBorder}>
              {child}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  label: { flexShrink: 1 },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 1,
    minWidth: 0,
  },
  summary: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
  },
  chevronExpanded: { transform: [{ rotate: "90deg" }] },
  hovered: { backgroundColor: theme.colors.surface2 },
  // The revealed rows keep the card's rails; the tint is what groups them under their header.
  children: { backgroundColor: theme.colors.surface0 },
}));
