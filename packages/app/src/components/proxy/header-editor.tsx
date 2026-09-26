import { useCallback, useMemo } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { ChevronDown } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ProxyHeader } from "@jagentdesk/protocol/proxy/rpc-schemas";
import type { Theme } from "@/styles/theme";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { WB_ORANGE } from "./workbench-constants";

// Editable request headers as key/value input rows (Burp's Inspector-style editing). The name field
// is free-text (custom headers) with a ▾ button that opens a suggestion menu of common header names.

export interface HeaderRowValue {
  id: string;
  name: string;
  value: string;
}

// Common request header names offered as suggestions (the tester can still type any custom name).
const COMMON_HEADERS = [
  "Accept",
  "Accept-Encoding",
  "Accept-Language",
  "Authorization",
  "Cache-Control",
  "Connection",
  "Content-Type",
  "Cookie",
  "Host",
  "Origin",
  "Referer",
  "User-Agent",
  "X-Requested-With",
  "X-CSRF-Token",
  "X-Forwarded-For",
  "If-None-Match",
  "Range",
];

const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedChevron = withUnistyles(ChevronDown);
const CHEVRON = <ThemedChevron size={14} uniProps={mutedColor} />;

let rowSeq = 0;
export function makeHeaderRows(headers: ProxyHeader[]): HeaderRowValue[] {
  return headers.map((h) => ({ id: `h${rowSeq++}`, name: h.name, value: h.value }));
}
export function rowsToHeaders(rows: HeaderRowValue[]): ProxyHeader[] {
  return rows.filter((r) => r.name.trim()).map((r) => ({ name: r.name, value: r.value }));
}

export function HeaderEditor({
  rows,
  onChange,
}: {
  rows: HeaderRowValue[];
  onChange: (rows: HeaderRowValue[]) => void;
}) {
  const addRow = useCallback(() => {
    onChange([...rows, { id: `h${rowSeq++}`, name: "", value: "" }]);
  }, [onChange, rows]);

  const updateRow = useCallback(
    (id: string, patch: Partial<HeaderRowValue>) => {
      onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    },
    [onChange, rows],
  );

  const removeRow = useCallback(
    (id: string) => onChange(rows.filter((r) => r.id !== id)),
    [onChange, rows],
  );

  return (
    <View style={styles.container}>
      {rows.map((r) => (
        <HeaderInputRow key={r.id} row={r} onUpdate={updateRow} onRemove={removeRow} />
      ))}
      <Pressable onPress={addRow} style={styles.addRow} testID="wb-header-add">
        <Text style={styles.addText}>+ Add header</Text>
      </Pressable>
    </View>
  );
}

function HeaderInputRow({
  row,
  onUpdate,
  onRemove,
}: {
  row: HeaderRowValue;
  onUpdate: (id: string, patch: Partial<HeaderRowValue>) => void;
  onRemove: (id: string) => void;
}) {
  const onName = useCallback((name: string) => onUpdate(row.id, { name }), [onUpdate, row.id]);
  const onValue = useCallback((value: string) => onUpdate(row.id, { value }), [onUpdate, row.id]);
  const onDelete = useCallback(() => onRemove(row.id), [onRemove, row.id]);
  const suggestions = useMemo(() => {
    const q = row.name.trim().toLowerCase();
    const list = q ? COMMON_HEADERS.filter((h) => h.toLowerCase().includes(q)) : COMMON_HEADERS;
    return list.length > 0 ? list : COMMON_HEADERS;
  }, [row.name]);
  return (
    <View style={styles.row}>
      <View style={styles.nameWrap}>
        <TextInput
          style={styles.nameInput}
          value={row.name}
          onChangeText={onName}
          placeholder="Header"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <DropdownMenu>
          <DropdownMenuTrigger style={styles.chevron} accessibilityLabel="Header suggestions">
            {CHEVRON}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" width={220}>
            {suggestions.map((h) => (
              <SuggestionItem key={h} name={h} rowId={row.id} onPick={onUpdate} />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </View>
      <Text style={styles.colon}>:</Text>
      <TextInput
        style={styles.valueInput}
        value={row.value}
        onChangeText={onValue}
        placeholder="value"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Pressable onPress={onDelete} hitSlop={6} style={styles.remove}>
        <Text style={styles.removeText}>✕</Text>
      </Pressable>
    </View>
  );
}

function SuggestionItem({
  name,
  rowId,
  onPick,
}: {
  name: string;
  rowId: string;
  onPick: (id: string, patch: Partial<HeaderRowValue>) => void;
}) {
  const handleSelect = useCallback(() => onPick(rowId, { name }), [name, onPick, rowId]);
  return <DropdownMenuItem onSelect={handleSelect}>{name}</DropdownMenuItem>;
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: { gap: theme.spacing[1] },
  row: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  nameWrap: {
    flexBasis: "40%",
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.sm,
  },
  nameInput: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    color: WB_ORANGE,
    paddingVertical: 3,
    paddingHorizontal: theme.spacing[2],
    outlineWidth: 0,
  },
  chevron: {
    paddingHorizontal: 4,
    paddingVertical: 3,
    alignItems: "center",
    justifyContent: "center",
  },
  colon: { color: theme.colors.foregroundMuted },
  valueInput: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
    paddingVertical: 3,
    paddingHorizontal: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.sm,
    outlineWidth: 0,
  },
  remove: { width: 22, height: 22, alignItems: "center", justifyContent: "center" },
  removeText: { color: theme.colors.foregroundMuted, fontSize: 13 },
  addRow: { paddingVertical: theme.spacing[1] },
  addText: { fontSize: theme.fontSize.xs, color: WB_ORANGE, fontWeight: theme.fontWeight.semibold },
}));
