import { useCallback, useMemo, type ReactElement, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { CHAT_COLUMN_RAIL_DATASET } from "@/chat-rail";
import { isWeb } from "@/constants/platform";
import type { Theme } from "@/styles/theme";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** Header height of every stacked track (spec 38 §4.4b). */
export const STACK_TRACK_HEADER_HEIGHT = 32;
const STACK_TRACK_LIST_MAX_HEIGHT = 200;

export interface ComposerStackTrackProps {
  testID: string;
  headerTestID: string;
  headerLabel: string;
  /** Mark drawn before the label — the running ring for background work. */
  leading?: ReactNode;
  /** Whole-track action shown at the right of the header, before the chevron. */
  headerAction?: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}

/**
 * A track that sits on top of the composer on wide screens: as wide as the composer, its bottom
 * edge tucked under the composer's top so the stack reads as one object. The subagents track and
 * the background work track share this shell so they look the same (spec 38 §4.4b).
 */
export function ComposerStackTrack({
  testID,
  headerTestID,
  headerLabel,
  leading,
  headerAction,
  expanded,
  onToggle,
  children,
}: ComposerStackTrackProps): ReactElement {
  const headerStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.headerToggle,
      (Boolean(hovered) || pressed) && styles.headerActive,
    ],
    [],
  );
  const headerContainerStyle = useMemo(
    () => [styles.header, expanded && styles.headerDivider],
    [expanded],
  );
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const ariaExpandedProps = isWeb ? { "aria-expanded": expanded } : null;
  return (
    <View style={styles.outer} testID={testID} dataSet={CHAT_COLUMN_RAIL_DATASET}>
      <View style={styles.track}>
        <View style={styles.surface}>
          <View style={headerContainerStyle} testID={`${headerTestID}-row`}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={headerLabel}
              accessibilityState={accessibilityState}
              {...ariaExpandedProps}
              testID={headerTestID}
              onPress={onToggle}
              style={headerStyle}
            >
              {leading ? <View style={styles.leading}>{leading}</View> : null}
              <Text style={styles.headerLabel} numberOfLines={1}>
                {headerLabel}
              </Text>
            </Pressable>
            {headerAction ? <View style={styles.headerAction}>{headerAction}</View> : null}
            <Pressable
              accessibilityElementsHidden
              importantForAccessibility="no"
              onPress={onToggle}
              style={styles.chevron}
              focusable={false}
            >
              {expanded ? (
                <ThemedChevronDown size={14} uniProps={foregroundMutedColorMapping} />
              ) : (
                <ThemedChevronRight size={14} uniProps={foregroundMutedColorMapping} />
              )}
            </Pressable>
          </View>
          {expanded ? (
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
              nestedScrollEnabled
            >
              {children}
            </ScrollView>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const TUCK = 16;

const styles = StyleSheet.create((theme) => ({
  // A transparent lane across the chat column: the chat outline rail sets its gutters on web.
  // Only the card inside is drawn, at the composer's width (spec 38 A38.4m).
  outer: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
  },
  track: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    marginBottom: -TUCK,
  },
  surface: {
    alignSelf: "stretch",
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderBottomWidth: 0,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    overflow: "hidden",
    // The strip the composer covers; the visible header stays 32 px.
    paddingBottom: TUCK,
  },
  header: {
    height: STACK_TRACK_HEADER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
  },
  headerDivider: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  headerToggle: {
    flex: 1,
    minWidth: 0,
    height: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[1],
  },
  headerActive: {
    backgroundColor: theme.colors.surface2,
  },
  leading: {
    width: 14,
    height: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  headerLabel: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: 13,
    color: theme.colors.foregroundMuted,
  },
  headerAction: {
    paddingRight: theme.spacing[1],
  },
  chevron: {
    height: "100%",
    paddingHorizontal: theme.spacing[3],
    alignItems: "center",
    justifyContent: "center",
  },
  scroll: {
    maxHeight: STACK_TRACK_LIST_MAX_HEIGHT,
  },
  scrollContent: {
    paddingVertical: theme.spacing[1],
  },
}));
