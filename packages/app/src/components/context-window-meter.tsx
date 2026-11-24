import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ContextWindowDetails } from "./context-window-details";
import { DetailsSheet } from "./details-sheet";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "./ui/hover-card";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import type { AgentMetric } from "@jagentdesk/protocol/agent-types";

interface ContextWindowMeterProps {
  maxTokens: number | null;
  usedTokens: number | null;
  totalCostUsd?: number | null;
  sessionMetrics?: AgentMetric[];
  showPercentage?: boolean;
  serverId?: string;
  /** The JAgentDesk provider key, e.g. "claude", "gemini", "codex" */
  provider?: string | null;
  /** Reserve the meter footprint and show a loading ring while usage is pending. */
  pending?: boolean;
  /** Optional glyph envelope for icon-toolbar alignment. */
  glyphSize?: number;
}

const SVG_SIZE = 14;
const COMPACT_SVG_SIZE = 12;
const COMPACT_CENTER = COMPACT_SVG_SIZE / 2;
const COMPACT_RADIUS = 5;
const STROKE_WIDTH = 2;
const COMPACT_STROKE_WIDTH = 1.75;
const COMPACT_CIRCUMFERENCE = 2 * Math.PI * COMPACT_RADIUS;

function isValidMaxTokens(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isValidUsedTokens(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function getUsagePercentage(maxTokens: number, usedTokens: number): number | null {
  if (!isValidMaxTokens(maxTokens) || !isValidUsedTokens(usedTokens)) {
    return null;
  }
  return (usedTokens / maxTokens) * 100;
}

function clampPercentage(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function formatSessionCost(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  if (value < 0.01) {
    return `$${value.toFixed(4)}`;
  }
  return `$${value.toFixed(2)}`;
}

function getMeterColors(
  percentage: number,
  theme: ReturnType<typeof useUnistyles>["theme"],
): { progress: string; track: string } {
  const track = theme.colors.surface3;
  if (percentage > 90) {
    return { progress: theme.colors.destructive, track };
  }
  if (percentage >= 70) {
    return { progress: theme.colors.palette.amber[500], track };
  }
  return { progress: theme.colors.foregroundMuted, track };
}

function getMeterGeometry(showPercentage: boolean, glyphSize?: number) {
  if (showPercentage) {
    return {
      svgSize: COMPACT_SVG_SIZE,
      center: COMPACT_CENTER,
      radius: COMPACT_RADIUS,
      strokeWidth: COMPACT_STROKE_WIDTH,
      circumference: COMPACT_CIRCUMFERENCE,
      containerStyle: styles.containerWithLabel,
    };
  }
  const resolvedSize = glyphSize ?? SVG_SIZE;
  const resolvedStrokeWidth = glyphSize ? 2 : STROKE_WIDTH;
  return {
    svgSize: resolvedSize,
    center: resolvedSize / 2,
    radius: (resolvedSize - resolvedStrokeWidth) / 2,
    strokeWidth: resolvedStrokeWidth,
    circumference: Math.PI * (resolvedSize - resolvedStrokeWidth),
    containerStyle: styles.container,
  };
}

function meterContext(maxTokens: number | null, usedTokens: number | null) {
  if (maxTokens === null || usedTokens === null) return null;
  const percentage = getUsagePercentage(maxTokens, usedTokens);
  return percentage === null ? null : { percentage: Math.round(percentage), usedTokens, maxTokens };
}

export function ContextWindowMeter({
  maxTokens,
  usedTokens,
  totalCostUsd,
  sessionMetrics = [],
  showPercentage = false,
  serverId,
  provider,
  pending = false,
  glyphSize,
}: ContextWindowMeterProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const openSheet = useCallback(() => setIsSheetOpen(true), []);
  const closeSheet = useCallback(() => setIsSheetOpen(false), []);
  const context = useMemo(() => meterContext(maxTokens, usedTokens), [maxTokens, usedTokens]);
  const percentage = context?.percentage ?? null;
  const geometry = getMeterGeometry(showPercentage, glyphSize);

  // No usage yet: reserve the footprint with a track-only ring while a session is
  // active so the real ring fades in without shifting siblings. Render nothing when
  // no usage is expected.
  if (context === null && sessionMetrics.length === 0) {
    if (!pending && sessionMetrics.length === 0) {
      return null;
    }
    return (
      <View style={geometry.containerStyle}>
        <Svg
          width={geometry.svgSize}
          height={geometry.svgSize}
          viewBox={`0 0 ${geometry.svgSize} ${geometry.svgSize}`}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Circle
            cx={geometry.center}
            cy={geometry.center}
            r={geometry.radius}
            fill="none"
            stroke={theme.colors.surface3}
            strokeWidth={geometry.strokeWidth}
          />
        </Svg>
        {showPercentage ? <View style={styles.skeletonLabel} /> : null}
      </View>
    );
  }

  const clampedPercentage = clampPercentage(percentage ?? 0);
  const roundedPercentage = Math.round(percentage ?? 0);
  const { svgSize, center, radius, strokeWidth, circumference, containerStyle } = geometry;
  const dashOffset = circumference - (clampedPercentage / 100) * circumference;
  const colors = getMeterColors(clampedPercentage, theme);
  const formattedSessionCost =
    typeof totalCostUsd === "number" ? formatSessionCost(totalCostUsd) : null;

  const trigger = (
    <Pressable
      style={containerStyle}
      testID="context-window-meter"
      accessibilityRole="button"
      onPress={isCompact ? openSheet : undefined}
      accessibilityLabel={t("contextWindow.accessibility", {
        percentage: roundedPercentage,
      })}
    >
      <Svg
        width={svgSize}
        height={svgSize}
        viewBox={`0 0 ${svgSize} ${svgSize}`}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={colors.track}
          strokeWidth={strokeWidth}
        />
        <Circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={colors.progress}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          // SVG strokes start at three o'clock; the ring reads clockwise from twelve.
          transform={`rotate(-90 ${center} ${center})`}
        />
      </Svg>
      {showPercentage ? (
        <Text style={styles.percentageLabel}>{`${roundedPercentage}%`}</Text>
      ) : null}
    </Pressable>
  );
  const details = (
    <ContextWindowDetails
      serverId={serverId ?? ""}
      provider={provider}
      context={context}
      sessionCost={formattedSessionCost}
      sessionMetrics={sessionMetrics}
      showTitle={!isCompact}
      refreshable={isCompact || !isNative}
    />
  );
  if (isCompact)
    return (
      <>
        {trigger}
        <DetailsSheet open={isSheetOpen} onClose={closeSheet} title={t("contextWindow.title")}>
          {details}
        </DetailsSheet>
      </>
    );
  if (isNative)
    return (
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile>
        <TooltipTrigger asChild triggerRefProp="ref">
          {trigger}
        </TooltipTrigger>
        <TooltipContent side="top" align="center" offset={8} testID="context-window-meter-tooltip">
          {details}
        </TooltipContent>
      </Tooltip>
    );
  return (
    <HoverCard>
      <HoverCardTrigger focusable accessibilityLabel={t("contextWindow.title")}>
        {trigger}
      </HoverCardTrigger>
      <HoverCardContent
        placement="top"
        offset={8}
        role="dialog"
        testID="context-window-details"
        style={styles.tooltipContent}
      >
        {details}
      </HoverCardContent>
    </HoverCard>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  containerWithLabel: {
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
  },
  percentageLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  skeletonLabel: {
    width: 22,
    height: theme.fontSize.sm,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
  },
  tooltipContent: {
    gap: theme.spacing[1.5],
    minWidth: 200,
  },
  tooltipTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  tooltipDetail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: theme.fontSize.xs * 1.4,
  },
}));
