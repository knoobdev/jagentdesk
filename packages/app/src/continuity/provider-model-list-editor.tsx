import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ProviderModelRef } from "@jagentdesk/protocol/messages";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { filterSelectableModels } from "@/provider-selection/model-catalog";
import { providerDisplayLabel } from "./use-agent-ledger";

interface PickerOption {
  key: string;
  ref: ProviderModelRef;
  label: string;
}

/** Enabled providers with their default model first, then each selectable model. */
function usePickerOptions(serverId: string): PickerOption[] {
  const { t } = useTranslation();
  const { entries } = useProvidersSnapshot(serverId);
  return useMemo(() => {
    const options: PickerOption[] = [];
    for (const entry of entries ?? []) {
      if (!entry.enabled || entry.status === "unavailable") continue;
      const label = entry.label ?? providerDisplayLabel(entry.provider);
      options.push({
        key: `${entry.provider}:`,
        ref: { provider: entry.provider, model: null },
        label: `${label} · ${t("continuity.ledger.defaultModel")}`,
      });
      for (const model of filterSelectableModels(entry.models ?? null) ?? []) {
        options.push({
          key: `${entry.provider}:${model.id}`,
          ref: { provider: entry.provider, model: model.id },
          label: `${label} · ${model.label}`,
        });
      }
    }
    return options;
  }, [entries, t]);
}

export function formatProviderModel(ref: ProviderModelRef, defaultLabel: string): string {
  return `${providerDisplayLabel(ref.provider)} · ${ref.model ?? defaultLabel}`;
}

function PickerRow({
  option,
  onPick,
}: {
  option: PickerOption;
  onPick: (ref: ProviderModelRef) => void;
}) {
  const handlePress = useCallback(() => onPick(option.ref), [onPick, option.ref]);
  return (
    <Pressable
      style={styles.pickerRow}
      onPress={handlePress}
      testID={`provider-model-option-${option.key}`}
    >
      <Text style={styles.rowText}>{option.label}</Text>
    </Pressable>
  );
}

function ProviderModelPickerSheet({
  serverId,
  onPick,
  onClose,
}: {
  serverId: string;
  onPick: (ref: ProviderModelRef) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const options = usePickerOptions(serverId);
  const header = useMemo(() => ({ title: t("continuity.settings.addProvider") }), [t]);
  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      desktopMaxWidth={520}
      testID="provider-model-picker"
    >
      <View>
        {options.map((option) => (
          <PickerRow key={option.key} option={option} onPick={onPick} />
        ))}
      </View>
    </AdaptiveModalSheet>
  );
}

function EntryRow({
  entry,
  index,
  count,
  onMove,
  onRemove,
  testIDPrefix,
}: {
  entry: ProviderModelRef;
  index: number;
  count: number;
  onMove: (index: number, delta: -1 | 1) => void;
  onRemove: (index: number) => void;
  testIDPrefix: string;
}) {
  const { t } = useTranslation();
  const moveUp = useCallback(() => onMove(index, -1), [index, onMove]);
  const moveDown = useCallback(() => onMove(index, 1), [index, onMove]);
  const remove = useCallback(() => onRemove(index), [index, onRemove]);
  return (
    <View style={styles.entryRow} testID={`${testIDPrefix}-entry-${index}`}>
      <Text style={styles.rowText} numberOfLines={1}>
        {index + 1}. {formatProviderModel(entry, t("continuity.ledger.defaultModel"))}
      </Text>
      <View style={styles.entryActions}>
        <Button size="sm" variant="ghost" onPress={moveUp} disabled={index === 0}>
          {t("continuity.settings.moveUp")}
        </Button>
        <Button size="sm" variant="ghost" onPress={moveDown} disabled={index === count - 1}>
          {t("continuity.settings.moveDown")}
        </Button>
        <Button size="sm" variant="ghost" onPress={remove}>
          {t("continuity.settings.remove")}
        </Button>
      </View>
    </View>
  );
}

/** An ordered list of provider/model entries (failover order, allowed child providers). */
export function ProviderModelListEditor({
  serverId,
  value,
  onChange,
  disabled = false,
  testIDPrefix,
}: {
  serverId: string;
  value: readonly ProviderModelRef[];
  onChange: (next: ProviderModelRef[]) => void;
  disabled?: boolean;
  testIDPrefix: string;
}) {
  const { t } = useTranslation();
  const [picking, setPicking] = useState(false);
  const openPicker = useCallback(() => setPicking(true), []);
  const closePicker = useCallback(() => setPicking(false), []);
  const handlePick = useCallback(
    (ref: ProviderModelRef) => {
      setPicking(false);
      if (value.some((entry) => entry.provider === ref.provider && entry.model === ref.model)) {
        return;
      }
      onChange([...value, ref]);
    },
    [onChange, value],
  );
  const handleMove = useCallback(
    (index: number, delta: -1 | 1) => {
      const target = index + delta;
      if (target < 0 || target >= value.length) return;
      const next = [...value];
      const moved = next[index];
      const other = next[target];
      if (!moved || !other) return;
      next[index] = other;
      next[target] = moved;
      onChange(next);
    },
    [onChange, value],
  );
  const handleRemove = useCallback(
    (index: number) => onChange(value.filter((_, position) => position !== index)),
    [onChange, value],
  );
  return (
    <View style={styles.list}>
      {value.length === 0 ? (
        <Text style={styles.muted}>{t("continuity.settings.emptyList")}</Text>
      ) : null}
      {value.map((entry, index) => (
        <EntryRow
          key={`${entry.provider}:${entry.model ?? ""}`}
          entry={entry}
          index={index}
          count={value.length}
          onMove={handleMove}
          onRemove={handleRemove}
          testIDPrefix={testIDPrefix}
        />
      ))}
      <View style={styles.addRow}>
        <Button
          size="sm"
          variant="outline"
          onPress={openPicker}
          disabled={disabled}
          testID={`${testIDPrefix}-add`}
        >
          {t("continuity.settings.addProvider")}
        </Button>
      </View>
      {picking ? (
        <ProviderModelPickerSheet serverId={serverId} onPick={handlePick} onClose={closePicker} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    gap: theme.spacing[2],
  },
  entryRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  entryActions: {
    flexDirection: "row",
    gap: theme.spacing[1],
  },
  addRow: {
    flexDirection: "row",
  },
  pickerRow: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
  },
  rowText: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
