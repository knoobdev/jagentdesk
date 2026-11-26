import { useCallback, useMemo, type ReactNode } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import type { StyleProp, TextStyle, ViewStyle } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  createControlGeometry,
  segmentedIconSize,
  type SegmentedControlSize,
} from "@/components/ui/control-geometry";
import type { Theme } from "@/styles/theme";
import { useIsGumloopTheme } from "@/components/gumloop-shell/use-gumloop-chrome";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type SegmentedControlIconRenderer = (props: { color: string; size: number }) => ReactNode;

export interface SegmentedControlOption<T extends string> {
  value: T;
  label: string;
  icon?: SegmentedControlIconRenderer;
  disabled?: boolean;
  testID?: string;
  /** Desktop hover hint, such as the segment's keyboard shortcut. */
  tooltip?: string;
}

interface SegmentedControlProps<T extends string> {
  options: SegmentedControlOption<T>[];
  value: T | null;
  onValueChange: (value: T) => void;
  size?: SegmentedControlSize;
  hideLabels?: boolean;
  /** Share the container's width equally between the segments, for a control that heads a surface. */
  fill?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

interface SegmentIconProps {
  icon: SegmentedControlIconRenderer;
  iconSize: number;
  iconColor: string;
}

function SegmentIcon({ icon, iconSize, iconColor }: SegmentIconProps) {
  return <View style={styles.iconContainer}>{icon({ color: iconColor, size: iconSize })}</View>;
}

const ThemedSegmentIcon = withUnistyles(SegmentIcon);

const selectedIconMapping = (theme: Theme) => ({ iconColor: theme.colors.surface0 });
const mutedIconMapping = (theme: Theme) => ({ iconColor: theme.colors.foregroundMuted });
const inkIconMapping = (theme: Theme) => ({ iconColor: theme.colors.foreground });

function iconMappingFor(isSelected: boolean, underline: boolean) {
  if (!isSelected) return mutedIconMapping;
  return underline ? inkIconMapping : selectedIconMapping;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onValueChange,
  size = "md",
  hideLabels = false,
  fill = false,
  style,
  testID,
}: SegmentedControlProps<T>) {
  const sizeStyles = {
    xs: { container: styles.containerXs, segment: styles.segmentXs, label: styles.labelXs },
    sm: { container: styles.containerSm, segment: styles.segmentSm, label: styles.labelSm },
    md: { container: styles.containerMd, segment: styles.segmentMd, label: styles.labelMd },
  }[size];
  const containerSizeStyle = sizeStyles.container;
  const segmentSizeStyle = sizeStyles.segment;
  const labelSizeStyle = sizeStyles.label;
  const iconSize = segmentedIconSize[size];

  // Gumloop shows these choices as underlined text tabs (To Do / Done / Delegated).
  const underline = useIsGumloopTheme();
  const containerStyle = useMemo(
    () => [styles.container, containerSizeStyle, underline && styles.containerUnderline, style],
    [containerSizeStyle, style, underline],
  );

  return (
    <View style={containerStyle} testID={testID}>
      {options.map((option) => {
        const isSelected = option.value === value;

        return (
          <SegmentItem
            key={option.value}
            option={option}
            isSelected={isSelected}
            iconSize={iconSize}
            hideLabels={hideLabels}
            fill={fill}
            segmentSizeStyle={segmentSizeStyle}
            labelSizeStyle={labelSizeStyle}
            currentValue={value}
            onValueChange={onValueChange}
            underline={underline}
          />
        );
      })}
    </View>
  );
}

function SegmentItem<T extends string>({
  option,
  isSelected,
  iconSize,
  hideLabels,
  fill,
  segmentSizeStyle,
  labelSizeStyle,
  currentValue,
  onValueChange,
  underline,
}: {
  underline: boolean;
  option: SegmentedControlOption<T>;
  isSelected: boolean;
  iconSize: number;
  hideLabels: boolean;
  fill: boolean;
  segmentSizeStyle: StyleProp<ViewStyle>;
  labelSizeStyle: StyleProp<TextStyle>;
  currentValue: T | null;
  onValueChange: (value: T) => void;
}) {
  const labelStyle = useMemo(() => {
    if (underline) {
      return [styles.label, labelSizeStyle, isSelected && styles.labelUnderlineSelected];
    }
    return [styles.label, labelSizeStyle, isSelected && styles.labelSelected];
  }, [labelSizeStyle, isSelected, underline]);
  const handlePress = useCallback(() => {
    if (!option.disabled && option.value !== currentValue) {
      onValueChange(option.value);
    }
  }, [option.disabled, option.value, currentValue, onValueChange]);
  const pressableStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) =>
      underline
        ? [
            styles.segment,
            segmentSizeStyle,
            fill && styles.segmentFill,
            styles.segmentUnderline,
            isSelected && styles.segmentUnderlineSelected,
            Boolean(hovered) && !isSelected && styles.segmentUnderlineHover,
            option.disabled && styles.segmentDisabled,
          ]
        : [
            styles.segment,
            segmentSizeStyle,
            fill && styles.segmentFill,
            isSelected && styles.segmentSelected,
            Boolean(hovered) && !isSelected && styles.segmentHover,
            pressed && !isSelected && styles.segmentPressed,
            option.disabled && styles.segmentDisabled,
          ],
    [fill, isSelected, option.disabled, segmentSizeStyle, underline],
  );
  const accessibilityState = useMemo(
    () => ({ selected: isSelected, disabled: option.disabled }),
    [isSelected, option.disabled],
  );
  const segment = (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      aria-selected={isSelected}
      disabled={option.disabled}
      testID={option.testID}
      onPress={handlePress}
      style={pressableStyle}
    >
      {option.icon ? (
        <ThemedSegmentIcon
          icon={option.icon}
          iconSize={iconSize}
          uniProps={iconMappingFor(isSelected, underline)}
        />
      ) : null}
      {hideLabels ? null : (
        <Text style={labelStyle} numberOfLines={1}>
          {option.label}
        </Text>
      )}
    </Pressable>
  );
  if (!option.tooltip) return segment;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{segment}</TooltipTrigger>
      <TooltipContent side="bottom" offset={8}>
        <Text style={styles.tooltipText}>{option.tooltip}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => {
  const geometry = createControlGeometry(theme);

  return {
    container: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: "transparent",
      gap: theme.spacing[1],
    },
    containerXs: {
      ...geometry.segmentedContainerXs,
    },
    containerSm: {
      ...geometry.segmentedContainerSm,
    },
    containerMd: {
      ...geometry.segmentedContainerMd,
    },
    segment: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
      gap: theme.spacing[1],
    },
    segmentXs: {
      ...geometry.segmentedSegmentXs,
    },
    segmentSm: {
      ...geometry.segmentedSegmentSm,
    },
    segmentMd: {
      ...geometry.segmentedSegmentMd,
    },
    segmentFill: {
      flexGrow: 1,
      flexBasis: 0,
      flexShrink: 1,
      minWidth: 0,
    },
    segmentSelected: {
      backgroundColor: theme.colors.foreground,
    },
    segmentHover: {
      backgroundColor: theme.colors.surface2,
    },
    segmentPressed: {
      backgroundColor: theme.colors.surface3,
    },
    segmentDisabled: {
      opacity: theme.opacity[50],
    },
    iconContainer: {
      alignItems: "center",
      justifyContent: "center",
    },
    label: {
      color: theme.colors.foregroundMuted,
      fontWeight: theme.fontWeight.normal,
    },
    labelXs: {
      ...geometry.segmentedLabelXs,
    },
    labelSm: {
      ...geometry.segmentedLabelSm,
    },
    labelMd: {
      ...geometry.segmentedLabelMd,
    },
    labelSelected: {
      color: theme.colors.surface0,
    },
    // Gumloop underline tabs: no pill, an ink bar under the selected label.
    containerUnderline: {
      paddingHorizontal: 0,
      paddingVertical: 0,
      backgroundColor: theme.colors.surface2,
      borderRadius: 12,
      padding: 4,
      gap: 4,
      borderWidth: 0,
    },
    segmentUnderline: {
      paddingHorizontal: 12,
      borderRadius: 8,
      backgroundColor: "transparent",
      borderBottomWidth: 2,
      borderBottomColor: "transparent",
    },
    segmentUnderlineSelected: {
      backgroundColor: theme.colors.surface1,
      ...theme.shadow.sm,
    },
    segmentUnderlineHover: {
      borderBottomColor: theme.colors.border,
    },
    labelUnderlineSelected: {
      color: theme.colors.foreground,
      fontWeight: theme.fontWeight.semibold,
    },
    tooltipText: {
      fontSize: theme.fontSize.base,
      color: theme.colors.popoverForeground,
    },
  };
});
