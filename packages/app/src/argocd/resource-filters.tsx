import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import type { Theme } from "@/styles/theme";
import {
  EMPTY_RESOURCE_FILTER,
  isFilterActive,
  type ArgoCdFilterOptions,
  type ArgoCdResourceFilter,
} from "./resources";

type FacetKey = "kinds" | "syncs" | "healths" | "namespaces";

const FACETS: ReadonlyArray<{ key: FacetKey; label: string }> = [
  { key: "kinds", label: "Kind" },
  { key: "syncs", label: "Sync" },
  { key: "healths", label: "Health" },
  { key: "namespaces", label: "Namespace" },
];

function FacetOption({
  value,
  selected,
  onToggle,
}: {
  value: string;
  selected: boolean;
  onToggle: (value: string) => void;
}) {
  const handleSelect = useCallback(() => onToggle(value), [onToggle, value]);
  return (
    <DropdownMenuItem
      selected={selected}
      showSelectedCheck
      closeOnSelect={false}
      onSelect={handleSelect}
    >
      {value}
    </DropdownMenuItem>
  );
}

function FacetMenu({
  facet,
  label,
  options,
  selected,
  onChange,
}: {
  facet: FacetKey;
  label: string;
  options: readonly string[];
  selected: readonly string[];
  onChange: (facet: FacetKey, values: string[]) => void;
}) {
  const handleToggle = useCallback(
    (value: string) => {
      const next = selected.includes(value)
        ? selected.filter((entry) => entry !== value)
        : [...selected, value];
      onChange(facet, next);
    },
    [facet, onChange, selected],
  );
  const triggerLabel = selected.length > 0 ? `${label} (${selected.length})` : label;
  return (
    <DropdownMenu>
      <DropdownTrigger
        style={selected.length > 0 ? [styles.trigger, styles.triggerActive] : styles.trigger}
        disabled={options.length === 0}
        accessibilityRole="button"
        accessibilityLabel={`Filter by ${label.toLowerCase()}`}
        testID={`argocd-filter-${facet}`}
      >
        <Text style={styles.triggerText}>{triggerLabel}</Text>
      </DropdownTrigger>
      <DropdownMenuContent align="start" maxHeight={360} scrollable>
        {options.map((value) => (
          <FacetOption
            key={value}
            value={value}
            selected={selected.includes(value)}
            onToggle={handleToggle}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Name / Kind / Sync / Health / Namespace filters over the resource views (spec 30.3). */
export function ArgoCdResourceFilters({
  filter,
  options,
  onChange,
}: {
  filter: ArgoCdResourceFilter;
  options: ArgoCdFilterOptions;
  onChange: (filter: ArgoCdResourceFilter) => void;
}) {
  // The name field is native-owned; clearing remounts it.
  const [nameResetKey, setNameResetKey] = useState(0);
  const handleName = useCallback(
    (name: string) => onChange({ ...filter, name }),
    [filter, onChange],
  );
  const handleFacet = useCallback(
    (facet: FacetKey, values: string[]) => onChange({ ...filter, [facet]: values }),
    [filter, onChange],
  );
  const handleClear = useCallback(() => {
    setNameResetKey((key) => key + 1);
    onChange(EMPTY_RESOURCE_FILTER);
  }, [onChange]);

  return (
    <View style={styles.bar}>
      <AdaptiveTextInput
        style={styles.search}
        initialValue={filter.name}
        resetKey={nameResetKey}
        onChangeText={handleName}
        placeholder="Filter by name"
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="Filter resources by name"
        testID="argocd-filter-name"
      />
      {FACETS.map((facet) => (
        <FacetMenu
          key={facet.key}
          facet={facet.key}
          label={facet.label}
          options={options[facet.key]}
          selected={filter[facet.key]}
          onChange={handleFacet}
        />
      ))}
      {isFilterActive(filter) ? (
        <Button variant="ghost" size="xs" onPress={handleClear}>
          Clear
        </Button>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  bar: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  search: {
    minWidth: 160,
    flexGrow: 1,
    flexBasis: 160,
    maxWidth: 280,
    height: 28,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    fontSize: theme.fontSize.xs,
  },
  trigger: {
    height: 28,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    justifyContent: "center",
  },
  triggerActive: {
    borderColor: theme.colors.accent,
  },
  triggerText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
}));
