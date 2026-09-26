// Comparer — a self-contained clone of Burp Suite CE's Comparer tool. The tester pastes text items
// into a list (each shown as "# · length · preview"), selects two of them, then runs a word-level or
// char-level ("bytes") comparison. The diff is an LCS alignment rendered in two columns with removed
// segments (left) and added segments (right) highlighted, mirroring Burp's word/byte compare views.
import { useCallback, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { Button } from "@/components/ui/button";
import { WB_ORANGE } from "./workbench-constants";

// ---------------------------------------------------------------------------
// Diff engine (LCS over tokens)
// ---------------------------------------------------------------------------

type SegType = "common" | "added" | "removed";

interface Seg {
  id: number;
  text: string;
  type: SegType;
}

interface DiffResult {
  left: Seg[];
  right: Seg[];
  mode: "words" | "bytes";
}

// Guard against O(n*m) blow-up on huge pastes; Burp similarly caps interactive compares.
const MAX_TOKENS = 4000;

function tokenize(str: string, mode: "words" | "bytes"): string[] {
  const raw = mode === "words" ? str.split(/(\s+)/).filter((x) => x.length > 0) : Array.from(str);
  return raw.length > MAX_TOKENS ? raw.slice(0, MAX_TOKENS) : raw;
}

function diffTokens(a: string[], b: string[]): { left: Seg[]; right: Seg[] } {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j]
          ? (dp[(i + 1) * w + (j + 1)] ?? 0) + 1
          : Math.max(dp[(i + 1) * w + j] ?? 0, dp[i * w + (j + 1)] ?? 0);
    }
  }
  const left: Seg[] = [];
  const right: Seg[] = [];
  let idc = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      const text = a[i] ?? "";
      left.push({ id: idc++, text, type: "common" });
      right.push({ id: idc++, text, type: "common" });
      i++;
      j++;
    } else if ((dp[(i + 1) * w + j] ?? 0) >= (dp[i * w + (j + 1)] ?? 0)) {
      left.push({ id: idc++, text: a[i] ?? "", type: "removed" });
      i++;
    } else {
      right.push({ id: idc++, text: b[j] ?? "", type: "added" });
      j++;
    }
  }
  while (i < n) {
    left.push({ id: idc++, text: a[i] ?? "", type: "removed" });
    i++;
  }
  while (j < m) {
    right.push({ id: idc++, text: b[j] ?? "", type: "added" });
    j++;
  }
  return { left, right };
}

function previewOf(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

interface Item {
  id: number;
  text: string;
}

type ToggleFn = (id: number) => void;

// ---------------------------------------------------------------------------
// Leaf components
// ---------------------------------------------------------------------------

function ItemRow({
  item,
  index,
  selected,
  onToggle,
}: {
  item: Item;
  index: number;
  selected: boolean;
  onToggle: ToggleFn;
}) {
  const handlePress = useCallback(() => onToggle(item.id), [onToggle, item.id]);
  return (
    <Pressable onPress={handlePress} style={[styles.item, selected && styles.itemSelected]}>
      <Text style={styles.itemMeta}>
        {`#${index + 1} · ${item.text.length} bytes · `}
        <Text style={styles.itemPreview}>{previewOf(item.text)}</Text>
      </Text>
    </Pressable>
  );
}

const SEG_STYLE_KEY: Record<SegType, "segCommon" | "segAdded" | "segRemoved"> = {
  common: "segCommon",
  added: "segAdded",
  removed: "segRemoved",
};

function SegView({ seg }: { seg: Seg }) {
  return <Text style={styles[SEG_STYLE_KEY[seg.type]]}>{seg.text}</Text>;
}

function DiffColumn({ title, segs }: { title: string; segs: Seg[] }) {
  return (
    <View style={styles.col}>
      <Text style={styles.colTitle}>{title}</Text>
      <ScrollView style={styles.colScroll}>
        <Text style={styles.mono}>
          {segs.map((seg) => (
            <SegView key={seg.id} seg={seg} />
          ))}
        </Text>
      </ScrollView>
    </View>
  );
}

function Legend() {
  return (
    <View style={styles.legend}>
      <View style={styles.swatchAdded} />
      <Text style={styles.legendLabel}>Added (right)</Text>
      <View style={styles.swatchRemoved} />
      <Text style={styles.legendLabel}>Removed (left)</Text>
    </View>
  );
}

function ResultView({ result }: { result: DiffResult }) {
  return (
    <View style={styles.resultBox}>
      <Text style={styles.resultTitle}>
        {result.mode === "words" ? "Word comparison" : "Byte comparison"}
      </Text>
      <Legend />
      <View style={styles.columns}>
        <DiffColumn title="Item A" segs={result.left} />
        <DiffColumn title="Item B" segs={result.right} />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function ComparerPanel() {
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const [result, setResult] = useState<DiffResult | null>(null);
  const nextId = useRef(0);

  const handleAdd = useCallback(() => {
    const text = input;
    if (text.trim().length === 0) return;
    setItems((prev) => [...prev, { id: nextId.current++, text }]);
    setInput("");
  }, [input]);

  const handleClear = useCallback(() => {
    setItems([]);
    setSelected([]);
    setResult(null);
    setInput("");
  }, []);

  const handleToggle = useCallback<ToggleFn>((id) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length < 2) return [...prev, id];
      return [prev[1] ?? id, id];
    });
  }, []);

  const runCompare = useCallback(
    (mode: "words" | "bytes") => {
      if (selected.length !== 2) return;
      const first = items.find((it) => it.id === selected[0]);
      const second = items.find((it) => it.id === selected[1]);
      if (!first || !second) return;
      const { left, right } = diffTokens(tokenize(first.text, mode), tokenize(second.text, mode));
      setResult({ left, right, mode });
    },
    [items, selected],
  );

  const handleCompareWords = useCallback(() => runCompare("words"), [runCompare]);
  const handleCompareBytes = useCallback(() => runCompare("bytes"), [runCompare]);

  const disabled = selected.length !== 2;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Comparer</Text>
      <Text style={styles.hint}>
        Paste an item and Add it. Select two items, then compare by words or bytes.
      </Text>
      <TextInput
        value={input}
        onChangeText={setInput}
        multiline
        placeholder="Paste text to add as a comparison item…"
        style={styles.input}
      />
      <View style={styles.toolbar}>
        <Button size="sm" variant="default" onPress={handleAdd}>
          Add
        </Button>
        <Button size="sm" variant="outline" onPress={handleClear}>
          Clear
        </Button>
      </View>

      <Text style={styles.section}>Items</Text>
      {items.length === 0 ? (
        <Text style={styles.empty}>No items yet. Paste some text above and press Add.</Text>
      ) : (
        items.map((item, index) => (
          <ItemRow
            key={item.id}
            item={item}
            index={index}
            selected={selected.includes(item.id)}
            onToggle={handleToggle}
          />
        ))
      )}

      <View style={styles.toolbar}>
        <Button size="sm" variant="secondary" onPress={handleCompareWords} disabled={disabled}>
          Compare (Words)
        </Button>
        <Button size="sm" variant="secondary" onPress={handleCompareBytes} disabled={disabled}>
          Compare (Bytes)
        </Button>
      </View>

      {result ? <ResultView result={result} /> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.surface0 },
  content: { padding: theme.spacing[3], gap: theme.spacing[2] },
  title: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
  },
  hint: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  input: {
    minHeight: 64,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.sm,
    padding: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    textAlignVertical: "top",
  },
  toolbar: { flexDirection: "row", gap: theme.spacing[2] },
  section: {
    marginTop: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
  },
  empty: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  item: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
  },
  itemSelected: { borderColor: WB_ORANGE },
  itemMeta: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
  },
  itemPreview: { color: theme.colors.foreground },
  resultBox: {
    marginTop: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[2],
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
  },
  resultTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  legend: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  legendLabel: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    marginRight: theme.spacing[2],
  },
  swatchAdded: {
    width: 12,
    height: 12,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.success,
  },
  swatchRemoved: {
    width: 12,
    height: 12,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.destructive,
  },
  columns: { flexDirection: "row", gap: theme.spacing[2] },
  col: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  colTitle: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundMuted,
  },
  colScroll: {
    maxHeight: 260,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.sm,
    padding: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
  },
  mono: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  segCommon: { color: theme.colors.foreground },
  segAdded: {
    color: theme.colors.success,
    backgroundColor: theme.colors.surface2,
    fontWeight: theme.fontWeight.semibold,
  },
  segRemoved: {
    color: theme.colors.destructive,
    backgroundColor: theme.colors.surface2,
    textDecorationLine: "line-through",
  },
}));
