import { useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { BarChart3, Coins, Cpu, Users } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useHosts } from "@/runtime/host-runtime";
import { useIsCompactFormFactor } from "@/constants/layout";
import { formatTokenCount } from "@/components/context-window-meter.utils";
import { useUsageInsights, type AgentUsageRow, type ModelUsageRow } from "@/insights/use-usage-insights";
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

function modelColor(index: number): string {
  return index < MODEL_COLORS.length ? MODEL_COLORS[index] : OTHER_COLOR;
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
        <Icon size={14} uniProps={mutedColor} />
        <Text style={styles.kpiLabel}>{label}</Text>
      </View>
      <Text style={styles.kpiValue}>{value}</Text>
      <Text style={styles.kpiSub}>{sub}</Text>
    </View>
  );
}

function ModelBar({ row, index, maxTokens }: { row: ModelUsageRow; index: number; maxTokens: number }) {
  const pct = maxTokens > 0 ? Math.max(4, Math.round((row.totalTokens / maxTokens) * 100)) : 0;
  const barStyle = useMemo(
    () => [styles.barFill, { width: `${pct}%` as const, backgroundColor: modelColor(index) }],
    [pct, index],
  );
  return (
    <View style={styles.barRow}>
      <View style={styles.barLabelRow}>
        <View style={[styles.swatch, { backgroundColor: modelColor(index) }]} />
        <Text style={styles.barLabel} numberOfLines={1}>
          {shortModel(row.model)}
        </Text>
        <Text style={styles.barValue}>
          {formatTokenCount(row.totalTokens)}
          {row.costUsd > 0 ? ` · ${formatUsd(row.costUsd)}` : ""}
        </Text>
      </View>
      <View style={styles.barTrack}>
        <View style={barStyle} />
      </View>
    </View>
  );
}

function AgentBar({ row, maxTokens }: { row: AgentUsageRow; maxTokens: number }) {
  const pct = maxTokens > 0 ? Math.max(4, Math.round((row.totalTokens / maxTokens) * 100)) : 0;
  const barStyle = useMemo(
    () => [styles.barFill, styles.agentBarFill, { width: `${pct}%` as const }],
    [pct],
  );
  return (
    <View style={styles.barRow}>
      <View style={styles.barLabelRow}>
        <Text style={styles.barLabel} numberOfLines={1}>
          {row.title}
        </Text>
        <Text style={styles.barValue}>
          {formatTokenCount(row.totalTokens)}
          {row.costUsd > 0 ? ` · ${formatUsd(row.costUsd)}` : ""}
        </Text>
      </View>
      <View style={styles.barTrack}>
        <View style={barStyle} />
      </View>
    </View>
  );
}

function ContextRow({ row }: { row: AgentUsageRow }) {
  const used = row.contextUsedTokens ?? 0;
  const max = row.contextMaxTokens ?? 1;
  const pct = Math.min(100, Math.round((used / max) * 100));
  const barStyle = useMemo(
    () => [styles.barFill, styles.contextBarFill, { width: `${Math.max(2, pct)}%` as const }],
    [pct],
  );
  return (
    <View style={styles.barRow}>
      <View style={styles.barLabelRow}>
        <Text style={styles.barLabel} numberOfLines={1}>
          {row.title}
        </Text>
        <Text style={styles.barValue}>
          {pct}% · {formatTokenCount(used)}/{formatTokenCount(max)}
        </Text>
      </View>
      <View style={styles.barTrack}>
        <View style={barStyle} />
      </View>
    </View>
  );
}

export function InsightsScreen() {
  const hosts = useHosts();
  const serverId = hosts[0]?.serverId ?? "";
  const insets = useSafeAreaInsets();
  const isCompact = useIsCompactFormFactor();
  const insights = useUsageInsights(serverId);

  const contentContainerStyle = useMemo(
    () => [styles.content, isCompact ? { paddingTop: insets.top } : null],
    [isCompact, insets.top],
  );

  const maxModelTokens = insights.byModel.reduce((m, r) => Math.max(m, r.totalTokens), 0);
  const maxAgentTokens = insights.topAgents.reduce((m, r) => Math.max(m, r.totalTokens), 0);
  const hasData = insights.agentsWithUsage > 0;

  return (
    <View style={styles.root}>
      <ScrollView style={styles.container} contentContainerStyle={contentContainerStyle}>
        <View style={styles.headerRow}>
          <ThemedBarChart size={20} uniProps={accentColor} />
          <Text style={styles.header}>Usage &amp; Cost</Text>
        </View>
        <Text style={styles.hint}>
          Aggregated live from every active agent session on this host — where your tokens go and
          which models drive cost, so an always-on JAgentDesk is never a black box.
        </Text>

        {!hasData ? (
          <Text style={styles.empty}>
            No usage yet. Start an agent and its token and cost totals will appear here.
          </Text>
        ) : (
          <>
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
                sub={insights.hasCost ? "reported by provider" : "not reported (subscription)"}
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

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Tokens by model</Text>
              {insights.byModel.map((row, i) => (
                <ModelBar key={row.model} row={row} index={i} maxTokens={maxModelTokens} />
              ))}
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Top agents by tokens</Text>
              {insights.topAgents.map((row) => (
                <AgentBar key={row.id} row={row} maxTokens={maxAgentTokens} />
              ))}
            </View>

            {insights.activeContext.length > 0 ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Context window · running agents</Text>
                {insights.activeContext.map((row) => (
                  <ContextRow key={row.id} row={row} />
                ))}
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.background },
  container: { flex: 1 },
  content: { padding: theme.spacing[4], paddingBottom: theme.spacing[8] },
  headerRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  header: {
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
  },
  hint: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    marginTop: theme.spacing[2],
    lineHeight: 20,
  },
  empty: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
    padding: theme.spacing[4],
  },
  kpiRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
    marginTop: theme.spacing[4],
  },
  kpi: {
    flexGrow: 1,
    flexBasis: "45%",
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: theme.spacing[1],
  },
  kpiHead: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1.5] },
  kpiLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundMuted,
    letterSpacing: 0.5,
  },
  kpiValue: {
    fontSize: theme.fontSize["3xl"],
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
  },
  kpiSub: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  card: {
    marginTop: theme.spacing[4],
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  cardTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    marginBottom: theme.spacing[1],
  },
  barRow: { gap: theme.spacing[1.5] },
  barLabelRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  swatch: { width: 10, height: 10, borderRadius: 3 },
  barLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  barValue: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
  },
  barTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  barFill: { height: 8, borderRadius: 4 },
  agentBarFill: { backgroundColor: theme.colors.accent },
  contextBarFill: { backgroundColor: "#2aa876" },
}));
