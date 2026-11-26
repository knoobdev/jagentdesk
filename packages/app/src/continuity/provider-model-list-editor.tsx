import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { GripVertical, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ProviderModelRef } from "@jagentdesk/protocol/messages";
import { DraggableList, DraggableListHandle } from "@/components/draggable-list";
import type { DraggableRenderItemInfo } from "@/components/draggable-list.types";
import { Button } from "@/components/ui/button";
import { extraMutedIconColorMapping } from "@/components/ui/icon-button-chrome";
import { paneContentToolbarIconSize, ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { AddProviderModelSheet, ProviderGlyph } from "./add-provider-model-sheet";
import { describeProviderModel, providerDisplayLabel } from "./provider-model-choices";

const ThemedGripVertical = withUnistyles(GripVertical);
const ThemedX = withUnistyles(X);
const DRAG_GRIP_SIZE = 14;

export function formatProviderModel(ref: ProviderModelRef, defaultLabel: string): string {
  return `${providerDisplayLabel(ref.provider)} · ${ref.model ?? defaultLabel}`;
}

function entryKey(entry: ProviderModelRef): string {
  return `${entry.provider}:${entry.model ?? ""}`;
}

function EntryRow({
  entry,
  label,
  reorderable,
  onRemove,
  testID,
}: {
  entry: ProviderModelRef;
  label: string;
  reorderable: boolean;
  onRemove: (entry: ProviderModelRef) => void;
  testID: string;
}) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const remove = useCallback(() => onRemove(entry), [entry, onRemove]);
  return (
    <View style={styles.entryRow} testID={testID}>
      {reorderable ? (
        <DraggableListHandle
          accessibilityLabel={t("continuity.settings.reorder", { entry: label })}
          style={styles.dragHandle}
          testID={`${testID}-drag`}
        >
          <ThemedGripVertical size={DRAG_GRIP_SIZE} uniProps={extraMutedIconColorMapping} />
        </DraggableListHandle>
      ) : null}
      <ProviderGlyph provider={entry.provider} />
      <Text style={styles.rowText} numberOfLines={1}>
        {label}
      </Text>
      <ToolbarButton
        label={t("continuity.settings.removeEntry", { entry: label })}
        compact={compact}
        onPress={remove}
        testID={`${testID}-remove`}
      >
        <ThemedX size={paneContentToolbarIconSize(compact)} uniProps={extraMutedIconColorMapping} />
      </ToolbarButton>
    </View>
  );
}

/**
 * An ordered list of provider/model entries: the failover order (`reorderable`, dragged by its
 * handles) or the providers child agents may use. "Add provider" opens the two-field form.
 */
export function ProviderModelListEditor({
  serverId,
  value,
  onChange,
  disabled = false,
  reorderable = false,
  testIDPrefix,
}: {
  serverId: string;
  value: readonly ProviderModelRef[];
  onChange: (next: ProviderModelRef[]) => void;
  disabled?: boolean;
  reorderable?: boolean;
  testIDPrefix: string;
}) {
  const { t } = useTranslation();
  const { entries } = useProvidersSnapshot(serverId);
  const defaultLabel = t("continuity.settings.defaultModel");
  const [adding, setAdding] = useState(false);
  const openAdd = useCallback(() => setAdding(true), []);
  const closeAdd = useCallback(() => setAdding(false), []);
  const data = useMemo(() => [...value], [value]);
  const labels = useMemo(
    () =>
      new Map(
        value.map((entry) => {
          const { providerLabel, modelLabel } = describeProviderModel(entry, entries, defaultLabel);
          return [entryKey(entry), `${providerLabel} · ${modelLabel}`] as const;
        }),
      ),
    [defaultLabel, entries, value],
  );
  const handleAdd = useCallback(
    (ref: ProviderModelRef) => {
      setAdding(false);
      if (value.some((entry) => entryKey(entry) === entryKey(ref))) return;
      onChange([...value, ref]);
    },
    [onChange, value],
  );
  const handleRemove = useCallback(
    (removed: ProviderModelRef) =>
      onChange(value.filter((entry) => entryKey(entry) !== entryKey(removed))),
    [onChange, value],
  );
  const handleDragEnd = useCallback((next: ProviderModelRef[]) => onChange(next), [onChange]);
  const renderRow = useCallback(
    (entry: ProviderModelRef, index: number) => (
      <EntryRow
        entry={entry}
        label={labels.get(entryKey(entry)) ?? formatProviderModel(entry, defaultLabel)}
        reorderable={reorderable}
        onRemove={handleRemove}
        testID={`${testIDPrefix}-entry-${index}`}
      />
    ),
    [defaultLabel, handleRemove, labels, reorderable, testIDPrefix],
  );
  const renderItem = useCallback(
    ({ item, index }: DraggableRenderItemInfo<ProviderModelRef>) => renderRow(item, index),
    [renderRow],
  );
  return (
    <View style={styles.list}>
      {value.length === 0 ? (
        <Text style={styles.muted}>{t("continuity.settings.emptyList")}</Text>
      ) : null}
      {value.length > 0 && reorderable ? (
        <DraggableList
          data={data}
          keyExtractor={entryKey}
          renderItem={renderItem}
          onDragEnd={handleDragEnd}
          extraData={labels}
          scrollEnabled={false}
          useDragHandle
          testID={`${testIDPrefix}-list`}
        />
      ) : null}
      {value.length > 0 && !reorderable ? (
        <View testID={`${testIDPrefix}-list`}>
          {data.map((entry, index) => (
            <View key={entryKey(entry)}>{renderRow(entry, index)}</View>
          ))}
        </View>
      ) : null}
      <View style={styles.addRow}>
        <Button
          size="sm"
          variant="outline"
          onPress={openAdd}
          disabled={disabled}
          testID={`${testIDPrefix}-add`}
        >
          {t("continuity.settings.addProvider")}
        </Button>
      </View>
      {adding ? (
        <AddProviderModelSheet
          serverId={serverId}
          listed={value}
          onAdd={handleAdd}
          onClose={closeAdd}
          testIDPrefix={testIDPrefix}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    gap: theme.spacing[2],
  },
  entryRow: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  dragHandle: {
    alignItems: "center",
    justifyContent: "center",
    width: theme.spacing[4],
    alignSelf: "stretch",
  },
  addRow: {
    flexDirection: "row",
  },
  rowText: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
