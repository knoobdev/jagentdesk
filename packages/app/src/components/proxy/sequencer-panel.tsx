// Sequencer — a self-contained clone of Burp Suite CE's Sequencer tool, limited to the
// "Manual load" + "Analysis" flow (live capture from a response is intentionally skipped). The
// tester pastes tokens one per line; on Analyze the panel reports sample stats and a Shannon
// entropy estimate. Entropy is computed per character position across the tokens (padded/truncated
// to the shortest sample) and summed to a total "bits per token", mirroring Burp's character-level
// analysis view. Everything is plain client-side JS — no fabricated results, and fewer than two
// samples yields a note asking for more.
import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { WbButton } from "./wb-button";
import { WB_ORANGE } from "./workbench-constants";

// ---------------------------------------------------------------------------
// Analysis model + helpers (kept small so each stays well under the complexity cap)
// ---------------------------------------------------------------------------

const MAX_POSITIONS = 32;

interface PositionStat {
  index: number;
  distinct: number;
  entropy: number;
}

interface Analysis {
  count: number;
  minLen: number;
  maxLen: number;
  meanLen: number;
  totalBits: number;
  quality: string;
  maxEntropy: number;
  positions: PositionStat[];
}

function parseTokens(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function computeLengths(tokens: string[]): { min: number; max: number; mean: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  let sum = 0;
  for (const token of tokens) {
    const len = token.length;
    if (len < min) min = len;
    if (len > max) max = len;
    sum += len;
  }
  return {
    min: tokens.length > 0 ? min : 0,
    max,
    mean: tokens.length > 0 ? sum / tokens.length : 0,
  };
}

// Shannon entropy (bits) of the character distribution at a single position across all tokens.
function positionEntropy(tokens: string[], pos: number): { distinct: number; entropy: number } {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    const ch = token.charAt(pos);
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  const total = tokens.length;
  let entropy = 0;
  for (const c of counts.values()) {
    const p = c / total;
    entropy -= p * Math.log2(p);
  }
  return { distinct: counts.size, entropy };
}

// A deliberate heuristic label — not a cryptographic verdict.
function qualityLabel(bits: number): string {
  if (bits < 40) return "poor";
  if (bits <= 80) return "reasonable";
  return "excellent";
}

function analyze(tokens: string[]): Analysis {
  const { min, max, mean } = computeLengths(tokens);
  const positions: PositionStat[] = [];
  let totalBits = 0;
  let maxEntropy = 0;
  for (let pos = 0; pos < min; pos++) {
    const { distinct, entropy } = positionEntropy(tokens, pos);
    totalBits += entropy;
    if (entropy > maxEntropy) maxEntropy = entropy;
    if (pos < MAX_POSITIONS) positions.push({ index: pos, distinct, entropy });
  }
  return {
    count: tokens.length,
    minLen: min,
    maxLen: max,
    meanLen: mean,
    totalBits,
    quality: qualityLabel(totalBits),
    maxEntropy,
    positions,
  };
}

// ---------------------------------------------------------------------------
// Leaf components (extracted so JSX never inlines a function/object/array prop
// and no subtree exceeds the max-depth cap)
// ---------------------------------------------------------------------------

function ClearButton({ onPress }: { onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.clearBtn}>
      <Text style={styles.clearLabel}>Clear</Text>
    </Pressable>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.summaryRow}>
      <Text style={styles.summaryLabel}>{label}</Text>
      <Text style={styles.summaryValue}>{value}</Text>
    </View>
  );
}

function SummaryView({ analysis }: { analysis: Analysis }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Summary</Text>
      <SummaryRow label="Sample count" value={String(analysis.count)} />
      <SummaryRow label="Min token length" value={String(analysis.minLen)} />
      <SummaryRow label="Max token length" value={String(analysis.maxLen)} />
      <SummaryRow label="Mean token length" value={analysis.meanLen.toFixed(1)} />
      <SummaryRow
        label="Overall entropy"
        value={`${analysis.totalBits.toFixed(1)} bits per token`}
      />
      <SummaryRow label="Quality (heuristic)" value={analysis.quality} />
    </View>
  );
}

function PositionBar({ pos, maxEntropy }: { pos: PositionStat; maxEntropy: number }) {
  const fillStyle = useMemo(() => {
    const ratio = maxEntropy > 0 ? pos.entropy / maxEntropy : 0;
    const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
    const width = `${pct}%` as const;
    return [styles.barFill, { width }];
  }, [pos.entropy, maxEntropy]);
  return (
    <View style={styles.posRow}>
      <Text style={styles.posIndex}>{`#${pos.index}`}</Text>
      <Text style={styles.posMeta}>{`${pos.distinct} chars`}</Text>
      <Text style={styles.posBits}>{`${pos.entropy.toFixed(2)} b`}</Text>
      <View style={styles.barTrack}>
        <View style={fillStyle} />
      </View>
    </View>
  );
}

function PositionList({
  positions,
  maxEntropy,
}: {
  positions: PositionStat[];
  maxEntropy: number;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Character-level analysis</Text>
      {positions.map((pos) => (
        <PositionBar key={String(pos.index)} pos={pos} maxEntropy={maxEntropy} />
      ))}
    </View>
  );
}

function NoteView() {
  return (
    <View style={styles.noteBox}>
      <Text style={styles.noteText}>
        Load at least 2 tokens (one per line), then Analyze to estimate entropy.
      </Text>
    </View>
  );
}

function Results({ analysis }: { analysis: Analysis | null }) {
  if (!analysis) return null;
  if (analysis.count < 2) return <NoteView />;
  return (
    <View style={styles.results}>
      <SummaryView analysis={analysis} />
      <PositionList positions={analysis.positions} maxEntropy={analysis.maxEntropy} />
    </View>
  );
}

function ButtonRow({ onAnalyze, onClear }: { onAnalyze: () => void; onClear: () => void }) {
  return (
    <View style={styles.buttonRow}>
      <WbButton label="Analyze" onPress={onAnalyze} />
      <ClearButton onPress={onClear} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function SequencerPanel() {
  const [text, setText] = useState("");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);

  const handleAnalyze = useCallback(() => {
    setAnalysis(analyze(parseTokens(text)));
  }, [text]);

  const handleClear = useCallback(() => {
    setText("");
    setAnalysis(null);
  }, []);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Sequencer</Text>
      <Text style={styles.hint}>
        Manual load: paste one token per line, then Analyze. Entropy is estimated per character
        position across the samples (padded/truncated to the shortest token) and summed to bits per
        token.
      </Text>
      <TextInput
        value={text}
        onChangeText={setText}
        multiline
        placeholder="Paste tokens, one per line…"
        style={styles.input}
      />
      <ButtonRow onAnalyze={handleAnalyze} onClear={handleClear} />
      <Results analysis={analysis} />
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.surface0 },
  content: { padding: theme.spacing[3], gap: theme.spacing[3] },
  title: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
  },
  hint: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  input: {
    minHeight: 140,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.sm,
    padding: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    textAlignVertical: "top",
  },
  buttonRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  clearBtn: {
    height: 30,
    paddingHorizontal: theme.spacing[4],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    alignItems: "center",
    justifyContent: "center",
  },
  clearLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  results: { gap: theme.spacing[3] },
  card: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
  },
  cardTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  summaryRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  summaryLabel: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  summaryValue: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  posRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  posIndex: {
    width: 36,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundExtraMuted,
  },
  posMeta: { width: 72, fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  posBits: {
    width: 64,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  barTrack: {
    flex: 1,
    height: 10,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  barFill: { height: 10, backgroundColor: WB_ORANGE },
  noteBox: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
  },
  noteText: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
}));
