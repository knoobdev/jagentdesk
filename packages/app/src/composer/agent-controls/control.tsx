import { forwardRef, useCallback } from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ComboboxTrigger } from "@/components/ui/combobox-trigger";
import { useComposerControlLayout } from "@/composer/agent-controls/layout-context";
import { ComposerToolbarGlyph } from "@/composer/agent-controls/glyph";
import type { AgentControlIcon } from "@/agent-controls/icons";

interface AgentControlTriggerProps {
  icon: AgentControlIcon;
  iconColor?: string;
  surface: "toolbar" | "sheet";
  label: string;
  value?: string;
  showToolbarLabel?: boolean;
  /**
   * When the toolbar trigger collapses to an icon-only pill (compact / phone),
   * a positive count renders a small numeric badge so the user still sees how
   * many items are attached. Ignored on desktop, where the full value label
   * already shows the count.
   */
  badgeCount?: number;
  showCaret?: boolean;
  open?: boolean;
  disabled?: boolean;
  onPress: () => void;
  accessibilityLabel: string;
  testID?: string;
}

export const AgentControlTrigger = forwardRef<View, AgentControlTriggerProps>(
  function AgentControlTrigger(
    {
      icon: Icon,
      iconColor,
      surface,
      label,
      value,
      showToolbarLabel = true,
      badgeCount,
      showCaret = false,
      open = false,
      disabled = false,
      onPress,
      accessibilityLabel,
      testID,
    },
    ref,
  ) {
    const { glyphSize } = useComposerControlLayout();
    const isSheet = surface === "sheet";
    const resolvedGlyphSize = isSheet ? 16 : glyphSize;
    const resolvedIconColor = iconColor ?? styles.iconColor.color;
    const showValue = isSheet || showToolbarLabel;
    const showBadge =
      !isSheet && !showToolbarLabel && typeof badgeCount === "number" && badgeCount > 0;
    const triggerStyle = useCallback(
      ({ pressed, hovered }: PressableStateCallbackType) => [
        isSheet ? styles.sheetRow : styles.toolbarControl,
        !isSheet && !showToolbarLabel && styles.toolbarIconOnly,
        hovered && (isSheet ? styles.sheetRowInteractive : styles.hovered),
        (pressed || open) && (isSheet ? styles.sheetRowInteractive : styles.pressed),
        disabled && styles.disabled,
      ],
      [disabled, isSheet, open, showToolbarLabel],
    );

    return (
      <ComboboxTrigger
        ref={ref}
        collapsable={false}
        disabled={disabled}
        onPress={onPress}
        style={triggerStyle}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        testID={testID}
        chevron={showCaret ? undefined : null}
      >
        {isSheet ? (
          <View style={styles.sheetGlyph}>
            <Icon size={resolvedGlyphSize} color={resolvedIconColor} />
          </View>
        ) : (
          <ComposerToolbarGlyph size={resolvedGlyphSize}>
            <Icon size={resolvedGlyphSize} color={resolvedIconColor} />
            {showBadge ? (
              <View style={styles.badge} pointerEvents="none">
                <Text style={styles.badgeText} numberOfLines={1}>
                  {badgeCount}
                </Text>
              </View>
            ) : null}
          </ComposerToolbarGlyph>
        )}
        {isSheet ? (
          <Text style={styles.sheetLabel} numberOfLines={1}>
            {label}
          </Text>
        ) : null}
        {showValue ? (
          <Text style={isSheet ? styles.sheetValue : styles.toolbarValue} numberOfLines={1}>
            {value ?? label}
          </Text>
        ) : null}
      </ComboboxTrigger>
    );
  },
);

const styles = StyleSheet.create((theme) => ({
  toolbarControl: {
    height: 28,
    minWidth: 0,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius["2xl"],
    backgroundColor: "transparent",
  },
  toolbarIconOnly: {
    width: 28,
    flexShrink: 0,
    paddingHorizontal: 0,
    justifyContent: "center",
  },
  toolbarValue: {
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  sheetRow: {
    minHeight: 44,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginHorizontal: -theme.spacing[1],
    paddingHorizontal: theme.spacing[4],
    borderRadius: theme.borderRadius["2xl"],
    backgroundColor: theme.colors.surface1,
  },
  sheetRowInteractive: {
    backgroundColor: theme.colors.surface2,
  },
  sheetGlyph: {
    width: 20,
    height: 20,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  sheetLabel: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  sheetValue: {
    maxWidth: "45%",
    minWidth: 0,
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  hovered: {
    backgroundColor: theme.colors.surface2,
  },
  pressed: {
    backgroundColor: theme.colors.surface0,
  },
  disabled: {
    opacity: 0.5,
  },
  iconColor: {
    color: theme.colors.foregroundMuted,
  },
  badge: {
    position: "absolute",
    top: -6,
    right: -8,
    minWidth: 14,
    height: 14,
    paddingHorizontal: 3,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    color: theme.colors.accentForeground,
    fontSize: 9,
    fontWeight: theme.fontWeight.semibold,
    lineHeight: 12,
  },
}));
