import { useMemo, type ReactElement, type ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SyncedLoader } from "@/components/synced-loader";
import { isEmphasizedStatusDotBucket } from "@/utils/status-dot-color";
import { shouldRenderSyncedStatusLoader } from "@/utils/status-loader";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
const DEFAULT_STATUS_DOT_SIZE = 7;
const EMPHASIZED_STATUS_DOT_SIZE = 9;
const DEFAULT_STATUS_DOT_OFFSET = -2;
const EMPHASIZED_STATUS_DOT_OFFSET = -3;

export function StatusIcon({
  children,
  statusBucket,
  size = 14,
  statusDotBorderColor,
}: {
  children: ReactNode;
  statusBucket: SidebarStateBucket | null;
  size?: number;
  statusDotBorderColor?: string;
  backdrop?: string;
}): ReactElement {
  const bucket = statusBucket;
  let statusDotColor: string | null = null;
  if (bucket === "needs_input") statusDotColor = styles.statusDotNeedsInput.color;
  else if (bucket === "failed") statusDotColor = styles.statusDotFailed.color;
  else if (bucket === "running") statusDotColor = styles.statusDotRunning.color;
  else if (bucket === "attention") statusDotColor = styles.statusDotAttention.color;
  const statusDotSize = isEmphasizedStatusDotBucket(statusBucket)
    ? EMPHASIZED_STATUS_DOT_SIZE
    : DEFAULT_STATUS_DOT_SIZE;
  const statusDotOffset =
    statusDotSize === EMPHASIZED_STATUS_DOT_SIZE
      ? EMPHASIZED_STATUS_DOT_OFFSET
      : DEFAULT_STATUS_DOT_OFFSET;
  const shouldShowLoader = shouldRenderSyncedStatusLoader({
    bucket: statusBucket,
  });
  const agentIconWrapperStyle = useMemo(
    () => [styles.agentIconWrapper, { width: size, height: size }],
    [size],
  );
  const statusDotStyle = useMemo(
    () => [
      styles.statusDot,
      {
        backgroundColor: statusDotColor ?? undefined,
        borderColor: statusDotBorderColor ?? styles.statusDotBorderDefault.borderColor,
        width: statusDotSize,
        height: statusDotSize,
        right: statusDotOffset,
        bottom: statusDotOffset,
      },
    ],
    [statusDotColor, statusDotBorderColor, statusDotSize, statusDotOffset],
  );

  if (shouldShowLoader) {
    return (
      <View
        style={agentIconWrapperStyle}
        accessibilityRole="progressbar"
        accessibilityLabel="Agent running"
      >
        <SyncedLoader size={size - 1} color={styles.syncedLoader.color} />
      </View>
    );
  }

  return (
    <View style={agentIconWrapperStyle}>
      {children}
      {statusDotColor ? <View style={statusDotStyle} /> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  agentIconWrapper: {
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
  },
  statusDot: {
    position: "absolute",
    right: DEFAULT_STATUS_DOT_OFFSET,
    bottom: DEFAULT_STATUS_DOT_OFFSET,
    width: DEFAULT_STATUS_DOT_SIZE,
    height: DEFAULT_STATUS_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
  },
  statusDotBorderDefault: {
    borderColor: theme.colors.surface0,
  },
  statusDotNeedsInput: {
    color: theme.colors.palette.amber[500],
  },
  statusDotFailed: {
    color: theme.colors.palette.red[500],
  },
  statusDotRunning: {
    color: theme.colors.palette.blue[500],
  },
  statusDotAttention: {
    color: theme.colors.palette.green[500],
  },
  iconActive: {
    color: theme.colors.foreground,
  },
  iconInactive: {
    color: theme.colors.foregroundMuted,
  },
  syncedLoader: {
    color:
      theme.colorScheme === "light"
        ? theme.colors.palette.amber[700]
        : theme.colors.palette.amber[500],
  },
  optionRow: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 36,
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    borderRadius: 0,
    marginHorizontal: theme.spacing[1],
    marginBottom: theme.spacing[1],
  },
  optionMainPressable: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  optionRowActive: {
    backgroundColor: theme.colors.surface1,
  },
  optionLeadingSlot: {
    width: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  optionContent: {
    flex: 1,
    flexShrink: 1,
  },
  optionLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  optionTrailingSlot: {
    width: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  optionModifiedDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
  },
  optionTrailingAccessorySlot: {
    alignItems: "center",
    justifyContent: "center",
  },
}));
