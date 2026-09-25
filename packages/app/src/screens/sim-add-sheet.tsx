import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Minus, Plus } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Skeleton, useSkeletonPulse } from "@/components/ui/skeleton";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { SimDeviceType, SimRuntime } from "@jagentdesk/protocol/simulator/rpc-schemas";
import type { Theme } from "@/styles/theme";
import { uniqueNames } from "@/screens/sim-names";
import { useIsClickUpTheme } from "@/components/clickup-shell/use-clickup-chrome";
import { clickUpChipStyles, clickUpListStyles } from "@/components/clickup-shell/list-styles";

const SELECTED = { selected: true } as const;
const UNSELECTED = { selected: false } as const;
const FAMILIES = ["iPhone", "iPad", "iPod"] as const;
type Family = (typeof FAMILIES)[number];
const MAX_COUNT = 10;
const SNAP_POINTS = ["75%", "94%"];
const SKELETON_ROWS = ["a", "b", "c", "d", "e"];

const fg = (theme: Theme) => ({ color: theme.colors.foreground });
const ThemedMinus = withUnistyles(Minus);
const ThemedPlus = withUnistyles(Plus);

function CatalogSkeleton() {
  const pulse = useSkeletonPulse();
  return (
    <View style={styles.body} testID="sim-add-loading">
      <Skeleton width={70} height={10} pulse={pulse} />
      <View style={styles.chips}>
        <Skeleton width={84} height={28} radius={14} pulse={pulse} />
        <Skeleton width={84} height={28} radius={14} pulse={pulse} />
      </View>
      <Skeleton width={70} height={10} pulse={pulse} />
      {SKELETON_ROWS.map((key) => (
        <Skeleton key={key} width="100%" height={34} pulse={pulse} />
      ))}
    </View>
  );
}

function CountStepper({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (value: number) => void;
  disabled: boolean;
}) {
  const dec = useCallback(() => onChange(Math.max(1, value - 1)), [onChange, value]);
  const inc = useCallback(() => onChange(Math.min(MAX_COUNT, value + 1)), [onChange, value]);
  return (
    <View style={styles.stepper}>
      <Pressable
        onPress={dec}
        disabled={disabled || value <= 1}
        style={[styles.stepBtn, value <= 1 ? styles.stepBtnDisabled : null]}
        accessibilityLabel="Fewer"
        testID="sim-add-count-dec"
      >
        <ThemedMinus size={14} uniProps={fg} />
      </Pressable>
      <Text style={styles.stepValue} testID="sim-add-count">
        {value}
      </Text>
      <Pressable
        onPress={inc}
        disabled={disabled || value >= MAX_COUNT}
        style={[styles.stepBtn, value >= MAX_COUNT ? styles.stepBtnDisabled : null]}
        accessibilityLabel="More"
        testID="sim-add-count-inc"
      >
        <ThemedPlus size={14} uniProps={fg} />
      </Pressable>
    </View>
  );
}

// Create simulators from what this Mac can actually run: `simctl list runtimes` gives each
// installed iOS runtime with the device types it supports, so every choice here is valid.
export function SimAddSheet({
  visible,
  client,
  existingNames,
  onClose,
  onCreated,
}: {
  visible: boolean;
  client: DaemonClient | null;
  existingNames: readonly string[];
  onClose: () => void;
  onCreated: (udids: string[]) => void;
}) {
  const [runtimes, setRuntimes] = useState<SimRuntime[] | null>(null);
  const [runtimeId, setRuntimeId] = useState<string | null>(null);
  const [family, setFamily] = useState<Family>("iPhone");
  const [typeId, setTypeId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [count, setCount] = useState(1);
  const [pending, setPending] = useState<"create" | "boot" | null>(null);
  const [done, setDone] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const isClickUp = useIsClickUpTheme();
  const labelStyle = [styles.label, isClickUp && clickUpListStyles.columnHeader];

  useEffect(() => {
    if (!visible || !client) return;
    let cancelled = false;
    setError(null);
    setPending(null);
    setName("");
    setTypeId(null);
    setCount(1);
    void client
      .simulatorCatalog()
      .then((res) => {
        if (cancelled) return undefined;
        if (res.error) setError(res.error);
        setRuntimes(res.runtimes);
        setRuntimeId((cur) => cur ?? res.runtimes[0]?.identifier ?? null);
        return undefined;
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load device types");
      });
    return () => {
      cancelled = true;
    };
  }, [visible, client]);

  const runtime = useMemo(
    () => runtimes?.find((r) => r.identifier === runtimeId) ?? null,
    [runtimes, runtimeId],
  );
  const families = useMemo(
    () => FAMILIES.filter((f) => runtime?.deviceTypes.some((t) => t.productFamily === f)),
    [runtime],
  );
  const types = useMemo(
    () => runtime?.deviceTypes.filter((t) => t.productFamily === family) ?? [],
    [runtime, family],
  );
  const type = useMemo(() => types.find((t) => t.identifier === typeId) ?? null, [types, typeId]);

  // All N are created (and booted) concurrently; each one lands in the fleet as it finishes.
  const create = useCallback(
    async (boot: boolean) => {
      if (!client || !runtime || !type || pending) return;
      setPending(boot ? "boot" : "create");
      setDone(0);
      setError(null);
      const names = uniqueNames(name.trim() || type.name, count, existingNames);
      const results = await Promise.all(
        names.map(async (deviceName) => {
          try {
            const res = await client.simulatorCreate({
              name: deviceName,
              deviceTypeId: type.identifier,
              runtimeId: runtime.identifier,
              boot,
            });
            return res.error ? { error: res.error } : { udid: res.udid };
          } catch (e: unknown) {
            return { error: e instanceof Error ? e.message : "Create failed" };
          } finally {
            setDone((n) => n + 1);
          }
        }),
      );
      setPending(null);
      const udids = results.flatMap((r) => ("udid" in r && r.udid ? [r.udid] : []));
      const failures = results.flatMap((r) => ("error" in r && r.error ? [r.error] : []));
      if (udids.length > 0) onCreated(udids);
      if (failures.length > 0) {
        setError(`${failures.length} of ${names.length} failed: ${failures[0]}`);
        return;
      }
      onClose();
    },
    [client, runtime, type, name, count, existingNames, pending, onCreated, onClose],
  );
  const onCreate = useCallback(() => void create(false), [create]);
  const onCreateBoot = useCallback(() => void create(true), [create]);
  const onCancel = useCallback(() => {
    if (!pending) onClose();
  }, [pending, onClose]);

  const header = useMemo<SheetHeader>(() => ({ title: "New simulator" }), []);
  const busy = pending !== null;
  let progress: string | null = null;
  if (busy) {
    const verb = pending === "boot" ? "Creating & booting" : "Creating";
    progress = count > 1 ? `${verb} ${Math.min(done + 1, count)} of ${count}…` : `${verb}…`;
  }

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onCancel}
      header={header}
      desktopMaxWidth={560}
      snapPoints={SNAP_POINTS}
      testID="sim-add-sheet"
    >
      <View style={styles.body}>
        {runtimes === null && !error ? <CatalogSkeleton /> : null}
        {runtimes && runtimes.length === 0 ? (
          <Text style={styles.muted}>
            No iOS simulator runtimes are installed. Install one from Xcode → Settings → Platforms.
          </Text>
        ) : null}

        {runtimes && runtimes.length > 0 ? (
          <>
            <Text style={labelStyle}>Runtime</Text>
            <View style={styles.chips}>
              {runtimes.map((r) => (
                <Chip
                  key={r.identifier}
                  label={r.name}
                  value={r.identifier}
                  active={r.identifier === runtimeId}
                  onPick={setRuntimeId}
                />
              ))}
            </View>

            <Text style={labelStyle}>Device</Text>
            <View style={styles.chips}>
              {families.map((f) => (
                <Chip key={f} label={f} value={f} active={f === family} onPick={setFamily} />
              ))}
            </View>
            <View style={styles.typeList}>
              {types.map((t) => (
                <TypeRow
                  key={t.identifier}
                  type={t}
                  active={t.identifier === typeId}
                  onPick={setTypeId}
                />
              ))}
            </View>

            <View style={styles.nameRow}>
              <View style={styles.nameCol}>
                <Text style={labelStyle}>Name</Text>
                <AdaptiveTextInput
                  resetKey={type?.identifier ?? "none"}
                  initialValue=""
                  onChangeText={setName}
                  placeholder={type?.name ?? "Pick a device first"}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!busy}
                  style={styles.input}
                  testID="sim-add-name"
                />
              </View>
              <View style={styles.countCol}>
                <Text style={labelStyle}>Quantity</Text>
                <CountStepper value={count} onChange={setCount} disabled={busy} />
              </View>
            </View>
          </>
        ) : null}

        {progress ? <Text style={styles.muted}>{progress}</Text> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={styles.actions}>
          <Button
            variant="secondary"
            size="sm"
            style={styles.action}
            onPress={onCancel}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            variant="secondary"
            size="sm"
            style={styles.action}
            onPress={onCreate}
            disabled={!type || busy}
            loading={pending === "create"}
            testID="sim-add-create"
          >
            Create
          </Button>
          <Button
            variant="default"
            size="sm"
            style={styles.action}
            leftIcon={Plus}
            onPress={onCreateBoot}
            disabled={!type || busy}
            loading={pending === "boot"}
            testID="sim-add-create-boot"
          >
            Create & boot
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

function Chip<T extends string>({
  label,
  value,
  active,
  onPick,
}: {
  label: string;
  value: T;
  active: boolean;
  onPick: (value: T) => void;
}) {
  const onPress = useCallback(() => onPick(value), [onPick, value]);
  const isClickUp = useIsClickUpTheme();
  return (
    <Pressable
      onPress={onPress}
      style={chipStyle(isClickUp, active)}
      accessibilityRole="button"
      accessibilityState={active ? SELECTED : UNSELECTED}
    >
      <Text style={chipTextStyle(isClickUp, active)}>{label}</Text>
    </Pressable>
  );
}

function TypeRow({
  type,
  active,
  onPick,
}: {
  type: SimDeviceType;
  active: boolean;
  onPick: (identifier: string) => void;
}) {
  const onPress = useCallback(() => onPick(type.identifier), [onPick, type.identifier]);
  const isClickUp = useIsClickUpTheme();
  return (
    <Pressable
      onPress={onPress}
      style={typeRowStyle(isClickUp, active)}
      accessibilityRole="button"
      accessibilityState={active ? SELECTED : UNSELECTED}
    >
      <Text style={typeTextStyle(isClickUp, active)}>{type.name}</Text>
    </Pressable>
  );
}

// ClickUp: white bordered filter chips, the picked one lavender with violet text.
function chipStyle(isClickUp: boolean, active: boolean) {
  if (isClickUp) return active ? clickUpChipStyles.chipActive : clickUpChipStyles.chip;
  return [styles.chip, active ? styles.chipActive : null];
}

function chipTextStyle(isClickUp: boolean, active: boolean) {
  if (isClickUp) return active ? clickUpChipStyles.textActive : clickUpChipStyles.text;
  return [styles.chipText, active ? styles.chipTextActive : null];
}

// ClickUp highlights the picked device type with the same lavender selection as its chips.
function typeRowStyle(isClickUp: boolean, active: boolean) {
  if (isClickUp && active) return [styles.typeRow, styles.typeRowActiveClickUp];
  return [styles.typeRow, active ? styles.typeRowActive : null];
}

function typeTextStyle(isClickUp: boolean, active: boolean) {
  if (isClickUp && active) return [styles.typeText, clickUpChipStyles.textActive];
  return [styles.typeText, active ? styles.chipTextActive : null];
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing[3], paddingBottom: theme.spacing[2] },
  label: {
    fontSize: theme.fontSize.xs,
    fontWeight: "600",
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase",
  },
  muted: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  chip: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  chipActive: { borderColor: theme.colors.accent, backgroundColor: theme.colors.surface2 },
  chipText: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  chipTextActive: { color: theme.colors.foreground },
  typeList: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    overflow: "hidden",
  },
  typeRow: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  typeRowActive: { backgroundColor: theme.colors.surface2 },
  typeRowActiveClickUp: { backgroundColor: theme.chrome.chipActiveBackground },
  typeText: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  input: {
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    fontSize: theme.fontSize.sm,
  },
  error: { color: theme.colors.palette.red[300], fontSize: theme.fontSize.sm },
  nameRow: { flexDirection: "row", gap: theme.spacing[3], alignItems: "flex-end" },
  nameCol: { flex: 1, gap: theme.spacing[2] },
  countCol: { gap: theme.spacing[2] },
  stepper: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    overflow: "hidden",
  },
  stepBtn: {
    width: 32,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface1,
  },
  stepBtnDisabled: { opacity: 0.4 },
  stepValue: {
    minWidth: 32,
    textAlign: "center",
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  actions: { flexDirection: "row", gap: theme.spacing[2] },
  action: { flex: 1 },
}));
