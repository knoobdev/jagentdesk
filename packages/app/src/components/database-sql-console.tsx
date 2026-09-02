import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { Play } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { DatabaseEngine, QueryResult } from "@jagentdesk/protocol/database/rpc-schemas";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useDatabaseViewStore } from "@/stores/database-view-store";
import { useDatabaseHistoryStore } from "@/stores/database-history-store";
import { DatabaseResultTable } from "@/components/database-result-table";
import type { Theme } from "@/styles/theme";

const ThemedPlay = withUnistyles(Play);
const ThemedTextInput = withUnistyles(TextInput);

// Stable empty reference: returning a fresh [] from the zustand selector on every
// render makes the default (Object.is) equality see a change each time → infinite
// re-render loop ("Maximum update depth exceeded"). Share one frozen array.
const EMPTY_HISTORY: readonly { sql: string; at_ms: number }[] = Object.freeze([]);
const accentForeground = (theme: Theme) => ({ color: theme.colors.accentForeground });
const placeholderColor = (theme: Theme) => ({
  placeholderTextColor: theme.colors.foregroundExtraMuted,
});

/** A statement that mutates data/schema — mirrors the daemon's read-only guard. */
function looksLikeWrite(sql: string): boolean {
  const head = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .trimStart()
    .slice(0, 24)
    .toLowerCase();
  return /^(insert|update|delete|drop|alter|create|truncate|replace|merge|grant|revoke|call|comment)\b/.test(
    head,
  );
}

type Tab = "result" | "output" | "plan";

// prettier-ignore
const SQL_KEYWORDS = [
  "select", "from", "where", "order by", "group by", "having", "limit", "offset",
  "insert into", "update", "delete from", "values", "set", "join", "left join",
  "right join", "inner join", "on", "as", "and", "or", "not", "null", "is null",
  "is not null", "in", "like", "between", "distinct", "count", "sum", "avg", "min",
  "max", "case", "when", "then", "else", "end", "asc", "desc", "returning",
];

const WORD_RE = /([A-Za-z_][A-Za-z0-9_]*)$/;

interface SchemaPool {
  tables: string[];
  columns: string[];
}

/** One completion suggestion chip — its own component so the press handler is
 *  stable (avoids react-perf's inline-function-as-prop). */
function SuggestionChip({ value, onPick }: { value: string; onPick: (v: string) => void }) {
  const press = useCallback(() => onPick(value), [onPick, value]);
  return (
    <Pressable style={styles.suggestChip} onPress={press}>
      <Text style={styles.suggestText}>{value}</Text>
    </Pressable>
  );
}

/** One result-set tab (its own component for a stable press handler). */
function ResultSetTab({
  id,
  label,
  active,
  onPick,
}: {
  id: number;
  label: string;
  active: boolean;
  onPick: (id: number) => void;
}) {
  const press = useCallback(() => onPick(id), [onPick, id]);
  return (
    <Pressable style={[styles.rsTab, active && styles.rsTabActive]} onPress={press}>
      <Text style={[styles.rsTabText, active && styles.rsTabTextActive]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function nowMs(): number {
  return Date.now();
}

/**
 * A schema-grounded SQL console — the DbClient analogue of the cluster shell. A
 * SELECT runs through the read-only `database/query` path and renders a result
 * grid; a write is refused unless the user flips "Allow writes", which routes it
 * through `database/exec`. Universal (desktop + mobile) — a multiline input, not
 * a desktop-only editor.
 */
// eslint-disable-next-line complexity
export function DatabaseSqlConsole({
  serverId,
  databaseId,
  engine,
}: {
  serverId: string;
  databaseId: string;
  engine: DatabaseEngine;
}) {
  const client = useHostRuntimeClient(serverId);
  const bumpRefresh = useDatabaseViewStore((s) => s.bumpRefresh);
  const recordHistory = useDatabaseHistoryStore((s) => s.record);
  const history = useDatabaseHistoryStore((s) => s.byDatabase[databaseId] ?? EMPTY_HISTORY);
  const [sql, setSql] = useState("");
  const [allowWrites, setAllowWrites] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [plan, setPlan] = useState<QueryResult | null>(null);
  const [output, setOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("result");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pool, setPool] = useState<SchemaPool>({ tables: [], columns: [] });
  // Multiple result sets — each successful SELECT opens a new tab (Services-style).
  const [resultSets, setResultSets] = useState<
    Array<{ id: number; label: string; result: QueryResult }>
  >([]);
  const [activeRs, setActiveRs] = useState<number | null>(null);
  const rsCounter = useRef(0);

  // Build a schema-aware completion pool once: table names across schemas + column
  // names (bounded so a huge database doesn't fan out to thousands of introspects).
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    void (async () => {
      const sc = await client.databaseSchemas({ id: databaseId }).catch(() => null);
      if (!sc || sc.error || cancelled) return;
      const tables = new Set<string>();
      const columns = new Set<string>();
      const addColumns = async (schemaName: string, tableName: string) => {
        const cols = await client
          .databaseColumns({ id: databaseId, schema: schemaName, table: tableName })
          .catch(() => null);
        if (cols && !cols.error) for (const c of cols.columns) columns.add(c.name);
      };
      let budget = 40;
      for (const s of sc.schemas) {
        const objs = await client
          .databaseObjects({ id: databaseId, schema: s.name })
          .catch(() => null);
        if (cancelled) return;
        if (!objs || objs.error) continue;
        for (const o of objs.objects) {
          tables.add(o.name);
          if (budget > 0) {
            budget--;
            await addColumns(s.name, o.name);
            if (cancelled) return;
          }
        }
      }
      if (!cancelled) setPool({ tables: [...tables], columns: [...columns] });
    })();
    return () => {
      cancelled = true;
    };
  }, [client, databaseId]);

  const suggestions = useMemo(() => {
    const m = WORD_RE.exec(sql);
    if (!m) return [];
    const word = m[1].toLowerCase();
    if (word.length < 1) return [];
    const all = [...pool.columns, ...pool.tables, ...SQL_KEYWORDS];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of all) {
      const low = s.toLowerCase();
      if (low.startsWith(word) && low !== word && !seen.has(s)) {
        seen.add(s);
        out.push(s);
        if (out.length >= 8) break;
      }
    }
    return out;
  }, [sql, pool]);

  const applySuggestion = useCallback((value: string) => {
    setSql((cur) => `${cur.replace(WORD_RE, value)} `);
  }, []);

  // Lightweight inspection: flag table names after FROM/JOIN that the schema pool
  // doesn't know, with a nearest-match quick-fix hint (DataGrip's error highlight).
  const inspections = useMemo(() => {
    if (pool.tables.length === 0) return [];
    const known = new Set(pool.tables.map((t) => t.toLowerCase()));
    const re = /\b(?:from|join)\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
    const flagged = new Set<string>();
    const out: string[] = [];
    let m: RegExpExecArray | null = re.exec(sql);
    while (m) {
      const t = m[1].toLowerCase();
      if (!known.has(t) && !flagged.has(t)) {
        flagged.add(t);
        const near = pool.tables.find((x) => x.toLowerCase().startsWith(t.slice(0, 3)));
        out.push(`Unknown table "${m[1]}"${near ? ` — did you mean ${near}?` : ""}`);
      }
      m = re.exec(sql);
    }
    return out;
  }, [sql, pool]);

  const pickResultSet = useCallback((id: number) => {
    setActiveRs(id);
    setResultSets((prev) => {
      const found = prev.find((r) => r.id === id);
      if (found) setResult(found.result);
      return prev;
    });
    setTab("result");
  }, []);

  const run = useCallback(async () => {
    if (!client) return;
    const trimmed = sql.trim().replace(/;\s*$/, "");
    if (!trimmed) return;
    setRunning(true);
    setError(null);
    setOutput(null);
    recordHistory(databaseId, trimmed, nowMs());
    try {
      if (looksLikeWrite(trimmed)) {
        if (!allowWrites) {
          setError('This is a write statement. Enable "Allow writes" to run it.');
          return;
        }
        const res = await client.databaseExec({ id: databaseId, sql: trimmed });
        if (res.error || !res.result) {
          setError(res.error ?? "Exec failed");
        } else {
          setResult(null);
          setOutput(`${res.result.affected} row(s) affected · ${res.result.elapsedMs} ms`);
          setTab("output");
          bumpRefresh();
        }
      } else {
        const res = await client.databaseQuery({ id: databaseId, sql: trimmed });
        if (res.error || !res.result) {
          setError(res.error ?? "Query failed");
        } else {
          setResult(res.result);
          const id = ++rsCounter.current;
          const label = trimmed.replace(/\s+/g, " ").slice(0, 22) || `Result ${id}`;
          const captured = res.result;
          setResultSets((prev) => [...prev, { id, label, result: captured }].slice(-6));
          setActiveRs(id);
          setOutput(
            `${res.result.rowCount} row(s)${res.result.truncated ? "+ (truncated)" : ""} · ${res.result.elapsedMs} ms`,
          );
          setTab("result");
        }
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Run failed");
    } finally {
      setRunning(false);
    }
  }, [client, sql, allowWrites, databaseId, bumpRefresh, recordHistory]);

  const explain = useCallback(async () => {
    if (!client) return;
    const trimmed = sql.trim().replace(/;\s*$/, "");
    if (!trimmed) return;
    setRunning(true);
    setError(null);
    try {
      const res = await client.databaseExplain({ id: databaseId, sql: trimmed });
      if (res.error || !res.result) {
        setError(res.error ?? "Explain failed");
      } else {
        setPlan(res.result);
        setTab("plan");
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Explain failed");
    } finally {
      setRunning(false);
    }
  }, [client, sql, databaseId]);

  const handleRun = useCallback(() => void run(), [run]);
  const handleExplain = useCallback(() => void explain(), [explain]);
  const showResult = useCallback(() => setTab("result"), []);
  const showOutput = useCallback(() => setTab("output"), []);
  const showPlan = useCallback(() => setTab("plan"), []);
  const toggleHistory = useCallback(() => setHistoryOpen((v) => !v), []);
  const recallSql = useCallback((value: string) => {
    setSql(value);
    setHistoryOpen(false);
  }, []);

  let resultBody;
  if (tab === "result") {
    resultBody = result ? (
      <View style={styles.resultWrap}>
        {resultSets.length > 1 ? (
          <ScrollView
            horizontal
            style={styles.rsBar}
            contentContainerStyle={styles.rsBarContent}
            keyboardShouldPersistTaps="always"
          >
            {resultSets.map((rs) => (
              <ResultSetTab
                key={rs.id}
                id={rs.id}
                label={rs.label}
                active={rs.id === activeRs}
                onPick={pickResultSet}
              />
            ))}
          </ScrollView>
        ) : null}
        <DatabaseResultTable result={result} />
      </View>
    ) : (
      <Text style={styles.hint}>Run a SELECT to see rows here.</Text>
    );
  } else if (tab === "plan") {
    resultBody = plan ? (
      <DatabaseResultTable result={plan} />
    ) : (
      <Text style={styles.hint}>Run Explain to see the query plan.</Text>
    );
  } else {
    resultBody = <Text style={styles.outputText}>{output ?? "No output yet."}</Text>;
  }

  return (
    <View style={styles.container}>
      <View style={styles.editorWrap}>
        <ThemedTextInput
          style={styles.editor}
          value={sql}
          onChangeText={setSql}
          placeholder={`-- SQL for ${engine}\nselect * from ...`}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          uniProps={placeholderColor}
        />
      </View>

      {suggestions.length > 0 ? (
        <ScrollView
          horizontal
          style={styles.suggestBar}
          contentContainerStyle={styles.suggestContent}
          keyboardShouldPersistTaps="always"
        >
          {suggestions.map((s) => (
            <SuggestionChip key={s} value={s} onPick={applySuggestion} />
          ))}
        </ScrollView>
      ) : null}

      {inspections.length > 0 ? (
        <View style={styles.inspectBar}>
          {inspections.map((msg) => (
            <Text key={msg} style={styles.inspectText} numberOfLines={1}>
              ⚠ {msg}
            </Text>
          ))}
        </View>
      ) : null}

      <View style={styles.toolbar}>
        <Pressable
          style={[styles.runBtn, running && styles.runBtnDisabled]}
          onPress={handleRun}
          disabled={running}
        >
          <ThemedPlay size={13} uniProps={accentForeground} />
          <Text style={styles.runText}>{running ? "Running…" : "Run"}</Text>
        </Pressable>
        <Pressable style={styles.tabBtn} onPress={handleExplain} disabled={running}>
          <Text style={styles.tabText}>Explain</Text>
        </Pressable>
        <Pressable
          style={historyOpen ? [styles.tabBtn, styles.tabBtnActive] : styles.tabBtn}
          onPress={toggleHistory}
        >
          <Text style={[styles.tabText, historyOpen && styles.tabTextActive]}>History</Text>
        </Pressable>
        <View style={styles.writesToggle}>
          <Switch value={allowWrites} onValueChange={setAllowWrites} />
          <Text style={styles.writesLabel}>Allow writes</Text>
        </View>
        <View style={styles.toolbarSpacer} />
        <Pressable
          style={[styles.tabBtn, tab === "result" && styles.tabBtnActive]}
          onPress={showResult}
        >
          <Text style={[styles.tabText, tab === "result" && styles.tabTextActive]}>Result</Text>
        </Pressable>
        <Pressable
          style={[styles.tabBtn, tab === "plan" && styles.tabBtnActive]}
          onPress={showPlan}
        >
          <Text style={[styles.tabText, tab === "plan" && styles.tabTextActive]}>Query Plan</Text>
        </Pressable>
        <Pressable
          style={[styles.tabBtn, tab === "output" && styles.tabBtnActive]}
          onPress={showOutput}
        >
          <Text style={[styles.tabText, tab === "output" && styles.tabTextActive]}>Output</Text>
        </Pressable>
      </View>

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <View style={styles.resultArea}>
        {historyOpen ? (
          <ScrollView style={styles.historyList}>
            {history.length === 0 ? (
              <Text style={styles.hint}>No history yet for this connection.</Text>
            ) : (
              history.map((h) => (
                <HistoryRow key={`${h.at_ms}-${h.sql}`} sql={h.sql} onSelect={recallSql} />
              ))
            )}
          </ScrollView>
        ) : (
          resultBody
        )}
      </View>
    </View>
  );
}

function HistoryRow({ sql, onSelect }: { sql: string; onSelect: (sql: string) => void }) {
  const handlePress = useCallback(() => onSelect(sql), [sql, onSelect]);
  return (
    <Pressable style={styles.historyRow} onPress={handlePress}>
      <Text style={styles.historyText} numberOfLines={2}>
        {sql}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  editorWrap: {
    minHeight: 120,
    maxHeight: 240,
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  editor: {
    flex: 1,
    padding: theme.spacing[3],
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
    textAlignVertical: "top",
  },
  suggestBar: {
    flexGrow: 0,
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  suggestContent: {
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  suggestChip: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 3,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  suggestText: {
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
  },
  inspectBar: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    gap: 2,
  },
  inspectText: { fontSize: theme.fontSize.xs, color: theme.colors.statusWarning },
  resultWrap: { flex: 1, minHeight: 0 },
  rsBar: {
    flexGrow: 0,
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  rsBarContent: { gap: theme.spacing[1], paddingHorizontal: theme.spacing[2], paddingVertical: 4 },
  rsTab: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 3,
    borderRadius: theme.borderRadius.sm,
  },
  rsTabActive: { backgroundColor: theme.colors.surface2 },
  rsTabText: {
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundMuted,
  },
  rsTabTextActive: { color: theme.colors.foreground },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  runBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.accent,
  },
  runBtnDisabled: {
    opacity: 0.5,
  },
  runText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.accentForeground,
  },
  writesToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  writesLabel: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  toolbarSpacer: {
    flexGrow: 1,
    flexBasis: theme.spacing[2],
  },
  tabBtn: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  tabBtnActive: {
    backgroundColor: theme.colors.surface2,
  },
  tabText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  tabTextActive: {
    color: theme.colors.foreground,
  },
  errorBox: {
    padding: theme.spacing[3],
    backgroundColor: theme.colors.palette.red[100],
  },
  errorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.palette.red[800],
  },
  resultArea: {
    flex: 1,
    minHeight: 0,
  },
  hint: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
    padding: theme.spacing[3],
  },
  outputText: {
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
    padding: theme.spacing[3],
  },
  historyList: {
    flex: 1,
    minHeight: 0,
  },
  historyRow: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  historyText: {
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
  },
}));
