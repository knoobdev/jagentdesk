import { useCallback, useMemo, useState, type ReactNode } from "react";
import { LayoutChangeEvent, Pressable, Text, View } from "react-native";
import Svg, { Line, Rect, Text as SvgText } from "react-native-svg";
import { StyleSheet } from "react-native-unistyles";
import type { UsageDayRollup } from "@jagentdesk/protocol/usage-history";
import { formatTokenCount } from "@/components/context-window-meter.utils";
import { useUsageHistory } from "@/insights/use-usage-history";
import type { Theme } from "@/styles/theme";

type Period = "day" | "month" | "year";
const PERIODS: readonly Period[] = ["day", "month", "year"] as const;
const PERIOD_LABEL: Record<Period, string> = { day: "Day", month: "Month", year: "Year" };
const MAX_BARS: Record<Period, number> = { day: 30, month: 12, year: 6 };

// Single-series accent (validated dataviz palette, dark-safe). One series → one hue.
const BAR_COLOR = "#3f8fd6";
const AXIS_COLOR = "#3a3f47";
const LABEL_COLOR = "#8a8f98";
const CHART_HEIGHT = 150;
const AXIS_PAD = 22;

interface Bucket {
  key: string;
  label: string;
  tokens: number;
  costUsd: number;
}

function rollupTokens(day: UsageDayRollup): number {
  // Excludes cache-READ tokens so the chart matches the headline TOKENS total (see
  // insights-screen); cache reads re-read the context every turn and inflate wildly.
  return day.inputTokens + day.outputTokens;
}

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function bucketize(days: UsageDayRollup[], period: Period): Bucket[] {
  const byKey = new Map<string, Bucket>();
  for (const day of days) {
    // date is `YYYY-MM-DD`.
    let key: string;
    let label: string;
    if (period === "day") {
      key = day.date;
      label = day.date.slice(8); // DD
    } else if (period === "month") {
      key = day.date.slice(0, 7); // YYYY-MM
      label = MONTH_NAMES[Number(day.date.slice(5, 7)) - 1] ?? day.date.slice(5, 7);
    } else {
      key = day.date.slice(0, 4); // YYYY
      label = key;
    }
    const existing = byKey.get(key) ?? { key, label, tokens: 0, costUsd: 0 };
    existing.tokens += rollupTokens(day);
    existing.costUsd += day.totalCostUsd;
    byKey.set(key, existing);
  }
  const sorted = Array.from(byKey.values()).sort((a, b) => a.key.localeCompare(b.key));
  return sorted.slice(Math.max(0, sorted.length - MAX_BARS[period]));
}

function formatUsd(value: number): string {
  if (value >= 100) return `$${value.toFixed(0)}`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(3)}`;
}

export function UsageTimelineCard({ serverId }: { serverId: string }) {
  const { days } = useUsageHistory(serverId);
  const [period, setPeriod] = useState<Period>("day");
  const [width, setWidth] = useState(0);

  const buckets = useMemo(() => bucketize(days, period), [days, period]);
  const maxTokens = useMemo(() => buckets.reduce((m, b) => Math.max(m, b.tokens), 0), [buckets]);
  const totals = useMemo(
    () =>
      buckets.reduce((acc, b) => ({ tokens: acc.tokens + b.tokens, cost: acc.cost + b.costUsd }), {
        tokens: 0,
        cost: 0,
      }),
    [buckets],
  );

  const onLayout = useCallback((e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width), []);

  let chartContent: ReactNode = null;
  if (buckets.length === 0) {
    chartContent = (
      <Text style={styles.empty}>
        No usage recorded yet. History starts accruing as agents run.
      </Text>
    );
  } else if (width > 0) {
    chartContent = <BarChart buckets={buckets} maxTokens={maxTokens} width={width} />;
  }

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <View>
          <Text style={styles.title}>Usage over time</Text>
          <Text style={styles.subtitle}>
            {formatTokenCount(totals.tokens)} tokens · {formatUsd(totals.cost)}
          </Text>
        </View>
        <View style={styles.toggle}>
          {PERIODS.map((p) => (
            <PeriodButton key={p} period={p} active={p === period} onSelect={setPeriod} />
          ))}
        </View>
      </View>

      <View style={styles.chartArea} onLayout={onLayout}>
        {chartContent}
      </View>
    </View>
  );
}

function PeriodButton({
  period,
  active,
  onSelect,
}: {
  period: Period;
  active: boolean;
  onSelect: (period: Period) => void;
}) {
  const handlePress = useCallback(() => onSelect(period), [onSelect, period]);
  return (
    <Pressable
      onPress={handlePress}
      style={[styles.toggleItem, active ? styles.toggleItemActive : null]}
      testID={`usage-period-${period}`}
    >
      <Text style={[styles.toggleText, active ? styles.toggleTextActive : null]}>
        {PERIOD_LABEL[period]}
      </Text>
    </Pressable>
  );
}

function BarChart({
  buckets,
  maxTokens,
  width,
}: {
  buckets: Bucket[];
  maxTokens: number;
  width: number;
}) {
  const height = CHART_HEIGHT;
  const plotH = height - AXIS_PAD;
  const n = buckets.length;
  const slot = width / n;
  const barW = Math.max(3, Math.min(28, slot * 0.6));
  const peakIndex = buckets.reduce((best, b, i) => (b.tokens > buckets[best].tokens ? i : best), 0);
  const labelStep = Math.ceil(n / Math.max(1, Math.floor(width / 34)));

  return (
    <Svg width={width} height={height}>
      <Line x1={0} y1={plotH} x2={width} y2={plotH} stroke={AXIS_COLOR} strokeWidth={1} />
      {buckets.map((b, i) => {
        const h = maxTokens > 0 ? Math.max(2, (b.tokens / maxTokens) * (plotH - 14)) : 2;
        const x = i * slot + (slot - barW) / 2;
        const y = plotH - h;
        return (
          <Rect
            key={b.key}
            x={x}
            y={y}
            width={barW}
            height={h}
            rx={2}
            fill={BAR_COLOR}
            opacity={i === peakIndex ? 1 : 0.82}
          />
        );
      })}
      {buckets.map((b, i) =>
        i === peakIndex ? (
          <SvgText
            key={`peak-${b.key}`}
            x={i * slot + slot / 2}
            y={plotH - (maxTokens > 0 ? Math.max(2, (b.tokens / maxTokens) * (plotH - 14)) : 2) - 4}
            fill={LABEL_COLOR}
            fontSize={9}
            textAnchor="middle"
          >
            {formatTokenCount(b.tokens)}
          </SvgText>
        ) : null,
      )}
      {buckets.map((b, i) =>
        i % labelStep === 0 ? (
          <SvgText
            key={`lbl-${b.key}`}
            x={i * slot + slot / 2}
            y={height - 6}
            fill={LABEL_COLOR}
            fontSize={9}
            textAnchor="middle"
          >
            {b.label}
          </SvgText>
        ) : null,
      )}
    </Svg>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  card: {
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 14,
    gap: 12,
  },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 },
  title: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" },
  subtitle: { color: theme.colors.foregroundMuted, fontSize: 12, marginTop: 2 },
  toggle: {
    flexDirection: "row",
    backgroundColor: theme.colors.surface0,
    borderRadius: 8,
    padding: 2,
    gap: 2,
  },
  toggleItem: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6 },
  toggleItemActive: { backgroundColor: theme.colors.surface3 },
  toggleText: { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "500" },
  toggleTextActive: { color: theme.colors.foreground },
  chartArea: { minHeight: CHART_HEIGHT, justifyContent: "center" },
  empty: { color: theme.colors.foregroundMuted, fontSize: 12, textAlign: "center" },
}));
