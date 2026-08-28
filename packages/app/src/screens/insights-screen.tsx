import { useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { BarChart3, Coins, Cpu, Users } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useHostRouteServerId } from "@/navigation/host-route-context";
import { useIsCompactFormFactor } from "@/constants/layout";
import { formatTokenCount } from "@/components/context-window-meter.utils";
import {
  useUsageInsights,
  type AgentUsageRow,
  type ModelUsageRow,
  type UsageInsights,
} from "@/insights/use-usage-insights";
import { UsageTimelineCard } from "@/insights/usage-timeline-card";
import type { Theme } from "@/styles/theme";

const ThemedBarChart = withUnistyles(BarChart3);
const ThemedCoins = withUnistyles(Coins);
const ThemedCpu = withUnistyles(Cpu);
const ThemedUsers = withUnistyles(Users);
const accentColor = (theme: Theme) => ({ color: theme.colors.accent });
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

// Validated categorical palette (dataviz skill, dark-safe, CVD-checked). Assigned
// to models in fixed rank order; a 5th+ model folds into the neutral "other" hue.
const MODEL_COLORS = ["#3f8fd6", "#c9821f", "#2aa876", "#c05fa0"] as const;
const OTHER_COLOR = "#8a8f98";
const CONTEXT_COLOR = "#2aa876";

function modelColor(index: number): string {
  return index >= 0 && index < MODEL_COLORS.length ? MODEL_COLORS[index] : OTHER_COLOR;
}

function formatUsd(value: number): string {
  if (value >= 100) {
    return `$${value.toFixed(0)}`;
  }
  if (value >= 1) {
    return `$${value.toFixed(2)}`;
  }
  return `$${value.toFixed(3)}`;
}

function shortModel(model: string): string {
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

function pctOf(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

function barWidth(part: number, max: number): number {
  return max > 0 ? Math.max(3, Math.round((part / max) * 100)) : 0;
}

type KpiIcon = React.ComponentType<{
  size?: number;
  uniProps?: (theme: Theme) => { color: string };
}>;

function KpiTile({
  Icon,
  label,
  value,
  sub,
}: {
  Icon: KpiIcon;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <View style={styles.kpi}>
      <View style={styles.kpiHead}>
        <Icon size={13} uniProps={mutedColor} />
        <Text style={styles.kpiLabel}>{label}</Text>
      </View>
      <Text style={styles.kpiValue} numberOfLines={1}>
        {value}
      </Text>
      <Text style={styles.kpiSub} numberOfLines={1}>
        {sub}
      </Text>
    </View>
  );
}

function Swatch({ color }: { color: string }) {
  const dot = useMemo(() => [styles.dot, { backgroundColor: color }], [color]);
  return <View style={dot} />;
}

function Bar({ color, pct }: { color: string; pct: number }) {
  const fill = useMemo(
    () => [styles.barFill, { width: `${pct}%` as const, backgroundColor: color }],
    [color, pct],
  );
  return (
    <View style={styles.barTrack}>
      <View style={fill} />
    </View>
  );
}

function ModelRow({
  row,
  index,
  maxTokens,
}: {
  row: ModelUsageRow;
  index: number;
  maxTokens: number;
}) {
  const color = modelColor(index);
  return (
    <View style={styles.item}>
      <View style={styles.itemTop}>
        <Swatch color={color} />
        <Text style={styles.itemName} numberOfLines={1}>
          {shortModel(row.model)}
        </Text>
        <Text style={styles.itemVal}>
          {formatTokenCount(row.totalTokens)}
          {row.costUsd > 0 ? ` · ${formatUsd(row.costUsd)}` : ""}
        </Text>
      </View>
      <Bar color={color} pct={barWidth(row.totalTokens, maxTokens)} />
    </View>
  );
}

function AgentRow({
  row,
  color,
  maxTokens,
}: {
  row: AgentUsageRow;
  color: string;
  maxTokens: number;
}) {
  return (
    <View style={styles.item}>
      <View style={styles.itemTop}>
        <Swatch color={color} />
        <Text style={styles.itemName} numberOfLines={1}>
          {row.title}
        </Text>
        <Text style={styles.itemVal}>
          {formatTokenCount(row.totalTokens)}
          {row.costUsd > 0 ? ` · ${formatUsd(row.costUsd)}` : ""}
        </Text>
      </View>
      <Bar color={color} pct={barWidth(row.totalTokens, maxTokens)} />
    </View>
  );
}

function ContextRow({ row }: { row: AgentUsageRow }) {
  const used = row.contextUsedTokens ?? 0;
  const max = row.contextMaxTokens ?? 1;
  const pct = Math.min(100, pctOf(used, max));
  return (
    <View style={styles.item}>
      <View style={styles.itemTop}>
        <Text style={styles.itemName} numberOfLines={1}>
          {row.title}
        </Text>
        <Text style={styles.itemVal}>
          {pct}% · {formatTokenCount(used)}/{formatTokenCount(max)}
        </Text>
      </View>
      <Bar color={CONTEXT_COLOR} pct={Math.max(2, pct)} />
    </View>
  );
}

function Card({
  title,
  subtitle,
  children,
  style,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  style?: object;
}) {
  const cardStyle = useMemo(() => [styles.card, style], [style]);
  return (
    <View style={cardStyle}>
      <View style={styles.cardHead}>
        <Text style={styles.cardTitle}>{title}</Text>
        {subtitle ? <Text style={styles.cardSubtitle}>{subtitle}</Text> : null}
      </View>
      {children}
    </View>
  );
}

function modelIndexByName(insights: UsageInsights): Map<string, number> {
  const map = new Map<string, number>();
  insights.byModel.forEach((row, i) => map.set(row.model, i));
  return map;
}

export function InsightsScreen() {
  // Read the host the user actually navigated into (like every sibling screen),
  // not raw hosts[0]: on mobile (tailscale mode) getHosts() returns every host in
  // registry order, so hosts[0] can be a different daemon than the viewed one and
  // sessions[hosts[0].serverId] is empty → the whole dashboard reads zeros.
  const serverId = useHostRouteServerId() ?? "";
  const insets = useSafeAreaInsets();
  const isCompact = useIsCompactFormFactor();
  const insights = useUsageInsights(serverId);

  const contentContainerStyle = useMemo(
    () => [styles.content, isCompact ? { paddingTop: insets.top } : null],
    [isCompact, insets.top],
  );
  const halfCard = useMemo(() => (isCompact ? styles.cardFull : styles.cardHalf), [isCompact]);

  const maxModelTokens = insights.byModel.reduce((m, r) => Math.max(m, r.totalTokens), 0);
  const maxAgentTokens = insights.topAgents.reduce((m, r) => Math.max(m, r.totalTokens), 0);
  const colorByModel = useMemo(() => modelIndexByName(insights), [insights]);
  const hasData = insights.agentsWithUsage > 0;
  const modelSubtitle = insights.hasCost
    ? `${insights.byModel.length} model${insights.byModel.length === 1 ? "" : "s"} · ${formatUsd(insights.totalCostUsd)}`
    : `${insights.byModel.length} model${insights.byModel.length === 1 ? "" : "s"}`;

  return (
    <View style={styles.root}>
      <ScrollView style={styles.container} contentContainerStyle={contentContainerStyle}>
        <View style={styles.headerRow}>
          <ThemedBarChart size={22} uniProps={accentColor} />
          <Text style={styles.header}>Usage &amp; Cost</Text>
        </View>
        <Text style={styles.hint}>
          Aggregated live from every active agent session on this host — where your tokens go and
          which models drive cost, so an always-on JAgentDesk is never a black box.
        </Text>

        {!hasData ? (
          <Text style={styles.banner}>
            No agent has reported usage on this host yet — the figures below stay at zero until one
            does.
          </Text>
        ) : null}

        <View style={styles.kpiRow}>
          <KpiTile
            Icon={ThemedCpu}
            label="TOKENS"
            value={formatTokenCount(insights.totalTokens)}
            sub={`${formatTokenCount(insights.totalInputTokens + insights.totalCachedInputTokens)} in · ${formatTokenCount(insights.totalOutputTokens)} out`}
          />
          <KpiTile
            Icon={ThemedCoins}
            label="COST"
            value={insights.hasCost ? formatUsd(insights.totalCostUsd) : "—"}
            sub={insights.hasCost ? "reported by provider" : "not reported"}
          />
          <KpiTile
            Icon={ThemedUsers}
            label="AGENTS"
            value={String(insights.agentsWithUsage)}
            sub={`of ${insights.agentCount} on host`}
          />
          <KpiTile
            Icon={ThemedCpu}
            label="AVG / AGENT"
            value={formatTokenCount(insights.avgTokensPerAgent)}
            sub="tokens per agent"
          />
        </View>

        <UsageTimelineCard serverId={serverId} />

        <View style={styles.cardsRow}>
          <Card title="Tokens by model" subtitle={modelSubtitle} style={halfCard}>
            {insights.byModel.length > 0 ? (
              insights.byModel.map((row, i) => (
                <ModelRow key={row.model} row={row} index={i} maxTokens={maxModelTokens} />
              ))
            ) : (
              <Text style={styles.cardEmpty}>No model usage yet.</Text>
            )}
          </Card>

          <Card title="Top agents by tokens" subtitle="this host" style={halfCard}>
            {insights.topAgents.length > 0 ? (
              insights.topAgents.map((row) => (
                <AgentRow
                  key={row.id}
                  row={row}
                  color={modelColor(colorByModel.get(row.model) ?? -1)}
                  maxTokens={maxAgentTokens}
                />
              ))
            ) : (
              <Text style={styles.cardEmpty}>No agent usage yet.</Text>
            )}
          </Card>
        </View>

        <Card title="Context window" subtitle="running agents" style={styles.cardFull}>
          {insights.activeContext.length > 0 ? (
            insights.activeContext.map((row) => <ContextRow key={row.id} row={row} />)
          ) : (
            <Text style={styles.cardEmpty}>No agent is running right now.</Text>
          )}
        </Card>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
  container: { flex: 1 },
  content: { padding: theme.spacing[4], paddingBottom: theme.spacing[8], gap: theme.spacing[4] },
  headerRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  header: {
    fontSize: theme.fontSize["2xl"],
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
  },
  hint: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    marginTop: -theme.spacing[2],
    lineHeight: 20,
    maxWidth: 720,
  },
  banner: {
    padding: theme.spacing[3],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    lineHeight: 20,
  },
  // KPI grid — auto-responsive: minWidth forces 2 cols on phones, 4 across on desktop.
  kpiRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[3] },
  kpi: {
    flexGrow: 1,
    flexBasis: "22%",
    minWidth: 150,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[2],
  },
  kpiHead: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1.5] },
  kpiLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundMuted,
    letterSpacing: 1,
  },
  kpiValue: {
    fontSize: theme.fontSize["4xl"],
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
    fontVariant: ["tabular-nums"],
    letterSpacing: -0.5,
  },
  kpiSub: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  // Card grid
  cardsRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[4] },
  card: {
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[4],
    gap: theme.spacing[4],
  },
  cardFull: { width: "100%" },
  cardHalf: { flexGrow: 1, flexBasis: "45%", minWidth: 320 },
  cardHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
  cardTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  cardSubtitle: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  cardEmpty: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
  },
  // Bar rows
  item: { gap: theme.spacing[2] },
  itemTop: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  dot: { width: 10, height: 10, borderRadius: 5 },
  itemName: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  itemVal: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
  },
  barTrack: {
    height: 10,
    borderRadius: 999,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  barFill: { height: 10, borderRadius: 999 },
}));
