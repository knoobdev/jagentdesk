import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Image,
  type LayoutChangeEvent,
  type GestureResponderEvent,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import {
  CircleAlert,
  House,
  Lock,
  Play,
  RefreshCw,
  Smartphone,
  Square,
  Trash2,
  Zap,
  ZapOff,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import type { SimAction, SimDevice } from "@jagentdesk/protocol/simulator/rpc-schemas";

const SCREENSHOT_POLL_MS = 1500;
const LOG_CAP = 40_000;

const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const fg = (theme: Theme) => ({ color: theme.colors.foreground });
const green = (theme: Theme) => ({ color: theme.colors.palette.green[600] });
const red500 = (theme: Theme) => ({ color: theme.colors.palette.red[500] });
const red600 = (theme: Theme) => ({ color: theme.colors.palette.red[600] });

const ThemedSmartphone = withUnistyles(Smartphone);
const ThemedPlay = withUnistyles(Play);
const ThemedSquare = withUnistyles(Square);
const ThemedTrash = withUnistyles(Trash2);
const ThemedZap = withUnistyles(Zap);
const ThemedZapOff = withUnistyles(ZapOff);
const ThemedHouse = withUnistyles(House);
const ThemedLock = withUnistyles(Lock);
const ThemedRefresh = withUnistyles(RefreshCw);
const ThemedAlert = withUnistyles(CircleAlert);

function randomId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}`;
}

function slimLabel(state: SimDevice["slimState"]): string {
  if (state === "slim") return "Slim";
  if (state === "partial") return "Partial";
  if (state === "stock") return "Stock";
  return "—";
}

function SlimBadge({ state }: { state: SimDevice["slimState"] }) {
  return (
    <View style={[styles.badge, state === "slim" ? styles.badgeSlim : styles.badgeStock]}>
      <Text style={styles.badgeText}>{slimLabel(state)}</Text>
    </View>
  );
}

function ToolbarButton({
  label,
  Icon,
  onPress,
  disabled,
  danger,
}: {
  label: string;
  Icon: typeof ThemedPlay;
  onPress: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled}
      style={[styles.toolBtn, disabled ? styles.toolBtnDisabled : null]}
    >
      <Icon size={15} uniProps={danger ? red500 : muted} />
      <Text style={[styles.toolBtnText, danger ? styles.toolBtnTextDanger : null]}>{label}</Text>
    </Pressable>
  );
}

function DeviceCard({
  device,
  selected,
  busy,
  onSelect,
  onBoot,
  onShutdown,
}: {
  device: SimDevice;
  selected: boolean;
  busy: boolean;
  onSelect: (udid: string) => void;
  onBoot: (udid: string) => void;
  onShutdown: (udid: string) => void;
}) {
  const select = useCallback(() => onSelect(device.udid), [device.udid, onSelect]);
  const boot = useCallback(() => onBoot(device.udid), [device.udid, onBoot]);
  const shutdown = useCallback(() => onShutdown(device.udid), [device.udid, onShutdown]);
  return (
    <Pressable
      onPress={select}
      style={[styles.card, selected ? styles.cardSelected : null]}
      accessibilityRole="button"
      accessibilityLabel={`Simulator ${device.name}`}
    >
      <View style={styles.cardHeader}>
        <View style={[styles.dot, device.isBooted ? styles.dotOn : styles.dotOff]} />
        <ThemedSmartphone size={15} uniProps={device.isBooted ? green : muted} />
        <Text style={styles.cardTitle} numberOfLines={1}>
          {device.name}
        </Text>
      </View>
      <Text style={styles.cardMeta} numberOfLines={1}>
        {device.runtime} · {device.state}
      </Text>
      <View style={styles.cardFooter}>
        <SlimBadge state={device.slimState} />
        {device.isBooted ? (
          <Pressable onPress={shutdown} disabled={busy} accessibilityLabel="Shut down" hitSlop={6}>
            <ThemedSquare size={16} uniProps={muted} />
          </Pressable>
        ) : (
          <Pressable onPress={boot} disabled={busy} accessibilityLabel="Boot" hitSlop={6}>
            <ThemedPlay size={16} uniProps={green} />
          </Pressable>
        )}
      </View>
    </Pressable>
  );
}

function DetailPane({
  device,
  hidAvailable,
  idbAvailable,
  screenshot,
  logs,
  busy,
  onAction,
  onToggleSlim,
  onButton,
  onImageLayout,
  onScreenTap,
}: {
  device: SimDevice;
  hidAvailable: boolean;
  idbAvailable: boolean;
  screenshot: string | null;
  logs: string;
  busy: boolean;
  onAction: (udid: string, action: SimAction) => void;
  onToggleSlim: () => void;
  onButton: (button: "home" | "lock") => void;
  onImageLayout: (e: LayoutChangeEvent) => void;
  onScreenTap: (e: GestureResponderEvent) => void;
}) {
  const boot = useCallback(() => onAction(device.udid, "boot"), [device.udid, onAction]);
  const shutdown = useCallback(() => onAction(device.udid, "shutdown"), [device.udid, onAction]);
  const erase = useCallback(() => onAction(device.udid, "erase"), [device.udid, onAction]);
  const del = useCallback(() => onAction(device.udid, "delete"), [device.udid, onAction]);
  const home = useCallback(() => onButton("home"), [onButton]);
  const lock = useCallback(() => onButton("lock"), [onButton]);
  const isSlim = device.slimState === "slim";
  const imageSource = useMemo(
    () => (screenshot ? { uri: `data:image/png;base64,${screenshot}` } : null),
    [screenshot],
  );

  let stage;
  if (!device.isBooted) {
    stage = <Text style={styles.stageHint}>Boot this simulator to see its screen.</Text>;
  } else if (imageSource) {
    stage = (
      <Pressable onPress={onScreenTap} onLayout={onImageLayout} style={styles.screenPressable}>
        <Image source={imageSource} style={styles.screenImage} resizeMode="contain" />
      </Pressable>
    );
  } else {
    stage = <Text style={styles.stageHint}>Capturing screen…</Text>;
  }

  return (
    <View style={styles.detail}>
      <View style={styles.toolbar}>
        {device.isBooted ? (
          <ToolbarButton label="Shutdown" Icon={ThemedSquare} onPress={shutdown} disabled={busy} />
        ) : (
          <ToolbarButton label="Boot" Icon={ThemedPlay} onPress={boot} disabled={busy} />
        )}
        <ToolbarButton
          label="Home"
          Icon={ThemedHouse}
          onPress={home}
          disabled={!device.isBooted || !idbAvailable}
        />
        <ToolbarButton
          label="Lock"
          Icon={ThemedLock}
          onPress={lock}
          disabled={!device.isBooted || !idbAvailable}
        />
        <ToolbarButton
          label={isSlim ? "Unslim" : "Slim"}
          Icon={isSlim ? ThemedZapOff : ThemedZap}
          onPress={onToggleSlim}
          disabled={busy || !device.isBooted}
        />
        <ToolbarButton label="Erase" Icon={ThemedRefresh} onPress={erase} disabled={busy} />
        <ToolbarButton label="Delete" Icon={ThemedTrash} onPress={del} disabled={busy} danger />
      </View>

      <View style={styles.stage}>{stage}</View>

      {!hidAvailable && device.isBooted ? (
        <Text style={styles.tapHint}>
          Install idb (idb_companion) or Maestro to tap, swipe and type here.
        </Text>
      ) : null}

      <ScrollView style={styles.logs} contentContainerStyle={styles.logsContent}>
        <Text style={styles.logsText}>{logs || "(no log output yet)"}</Text>
      </ScrollView>
    </View>
  );
}

export function SimFleetScreen() {
  const hosts = useHosts();
  const serverId = hosts[0]?.serverId ?? "";
  const client = useHostRuntimeClient(serverId);
  const insets = useSafeAreaInsets();
  const isCompact = useIsCompactFormFactor();

  const [availability, setAvailability] = useState({
    simctl: true,
    idb: false,
    maestro: false,
    xcode: false,
  });
  const [devices, setDevices] = useState<SimDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedUdid, setSelectedUdid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [logs, setLogs] = useState("");
  const [screenPoint, setScreenPoint] = useState<{ w: number; h: number } | null>(null);
  const imgLayout = useRef<{ w: number; h: number }>({ w: 0, h: 0 });

  const selected = useMemo(
    () => devices.find((d) => d.udid === selectedUdid) ?? null,
    [devices, selectedUdid],
  );

  // Realtime fleet snapshot (the daemon polls `simctl list` and pushes).
  useEffect(() => {
    if (!client) {
      setLoading(false);
      return;
    }
    const subscriptionId = randomId("sim");
    const off = client.onSimulatorSnapshot(subscriptionId, (snap) => {
      setAvailability(snap.availability);
      setDevices(snap.devices);
      setError(null);
      setLoading(false);
    });
    void client.simulatorSubscribe({ subscriptionId }).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : "Failed to reach the simulator host");
      setLoading(false);
    });
    return () => {
      off();
      client.simulatorUnsubscribe({ subscriptionId });
    };
  }, [client]);

  // Live screen (screenshot poll) + live logs for the selected booted device.
  useEffect(() => {
    setScreenshot(null);
    setLogs("");
    setScreenPoint(null);
    if (!client || !selected || !selected.isBooted) return;
    const udid = selected.udid;
    let cancelled = false;
    const grab = () => {
      void (async () => {
        try {
          const res = await client.simulatorScreenshot({ udid });
          if (!cancelled && res.pngBase64) setScreenshot(res.pngBase64);
        } catch {
          /* transient — next poll retries */
        }
      })();
    };
    grab();
    const timer = setInterval(grab, SCREENSHOT_POLL_MS);
    // Screen point size (for tap mapping) from the accessibility tree (idb or Maestro backend).
    if (availability.idb || availability.maestro) {
      void (async () => {
        try {
          const res = await client.simulatorDescribeUi({ udid });
          if (cancelled) return;
          let w = 0;
          let h = 0;
          for (const el of res.elements) {
            w = Math.max(w, el.x + el.width);
            h = Math.max(h, el.y + el.height);
          }
          if (w > 0 && h > 0) setScreenPoint({ w, h });
        } catch {
          /* tap mapping stays disabled */
        }
      })();
    }
    const logSub = randomId("sim-log");
    const offLog = client.onSimulatorLogChunk(logSub, (chunk) => {
      if (cancelled) return;
      setLogs((prev) => (prev + chunk.chunk).slice(-LOG_CAP));
    });
    void client.simulatorLogsSubscribe({ subscriptionId: logSub, udid }).catch(() => {});
    return () => {
      cancelled = true;
      clearInterval(timer);
      offLog();
      client.simulatorLogsUnsubscribe({ subscriptionId: logSub });
    };
  }, [client, selected, availability.idb, availability.maestro]);

  const runAction = useCallback(
    async (udid: string, action: SimAction) => {
      if (!client) return;
      setBusy(true);
      setError(null);
      try {
        const res = await client.simulatorAction({ udid, action });
        if (res.error) setError(res.error);
        if ((action === "delete" || action === "erase") && selectedUdid === udid) {
          setSelectedUdid(null);
        }
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Action failed");
      } finally {
        setBusy(false);
      }
    },
    [client, selectedUdid],
  );

  const onBoot = useCallback((udid: string) => void runAction(udid, "boot"), [runAction]);
  const onShutdown = useCallback((udid: string) => void runAction(udid, "shutdown"), [runAction]);
  const onSelect = useCallback((udid: string) => setSelectedUdid(udid), []);

  const toggleSlim = useCallback(async () => {
    if (!client || !selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.slimState === "slim") await client.simulatorUnslim({ udid: selected.udid });
      else await client.simulatorSlim({ udid: selected.udid, reboot: false });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Slim failed");
    } finally {
      setBusy(false);
    }
  }, [client, selected]);

  const pressButton = useCallback(
    async (button: "home" | "lock") => {
      if (!client || !selected) return;
      try {
        await client.simulatorButton({ udid: selected.udid, button });
      } catch {
        /* surfaced via error state elsewhere */
      }
    },
    [client, selected],
  );

  const onImageLayout = useCallback((e: LayoutChangeEvent) => {
    imgLayout.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height };
  }, []);

  const onScreenTap = useCallback(
    (e: GestureResponderEvent) => {
      if (!client || !selected || !screenPoint) return;
      const { locationX, locationY } = e.nativeEvent;
      const { w, h } = imgLayout.current;
      if (!w || !h) return;
      const x = (locationX / w) * screenPoint.w;
      const y = (locationY / h) * screenPoint.h;
      void client.simulatorTap({ udid: selected.udid, x, y }).catch(() => {});
    },
    [client, selected, screenPoint],
  );

  const containerStyle = useMemo(
    () => [styles.screen, isCompact ? { paddingTop: insets.top } : null],
    [isCompact, insets.top],
  );

  const showUnavailable = !loading && !availability.simctl;

  return (
    <View style={containerStyle}>
      <View style={styles.header}>
        <ThemedSmartphone size={18} uniProps={fg} />
        <Text style={styles.headerTitle}>SimFleet</Text>
        <Text style={styles.headerCount}>
          {devices.filter((d) => d.isBooted).length}/{devices.length} booted
        </Text>
      </View>

      {error ? (
        <View style={styles.errorBar}>
          <ThemedAlert size={14} uniProps={red600} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {showUnavailable ? (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>
            iOS simulators are unavailable on this host. SimFleet needs macOS with Xcode (and `idb`
            for tap/type control).
          </Text>
        </View>
      ) : null}

      <View style={[styles.body, isCompact ? styles.bodyCompact : null]}>
        <ScrollView
          style={[styles.fleet, isCompact ? styles.fleetCompact : null]}
          contentContainerStyle={styles.fleetContent}
        >
          {devices.length === 0 && !loading ? (
            <Text style={styles.empty}>No iOS simulators found.</Text>
          ) : (
            devices.map((device) => (
              <DeviceCard
                key={device.udid}
                device={device}
                selected={device.udid === selectedUdid}
                busy={busy}
                onSelect={onSelect}
                onBoot={onBoot}
                onShutdown={onShutdown}
              />
            ))
          )}
        </ScrollView>

        {selected ? (
          <DetailPane
            device={selected}
            hidAvailable={availability.idb || availability.maestro}
            idbAvailable={availability.idb}
            screenshot={screenshot}
            logs={logs}
            busy={busy}
            onAction={runAction}
            onToggleSlim={toggleSlim}
            onButton={pressButton}
            onImageLayout={onImageLayout}
            onScreenTap={onScreenTap}
          />
        ) : (
          <View style={styles.detail}>
            <View style={styles.detailEmpty}>
              <Text style={styles.stageHint}>Select a simulator to view and drive it.</Text>
            </View>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.surface0 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  headerTitle: { fontSize: theme.fontSize.lg, fontWeight: "600", color: theme.colors.foreground },
  headerCount: {
    marginLeft: "auto",
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  errorBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.palette.red[100],
  },
  errorText: { color: theme.colors.palette.red[800], fontSize: theme.fontSize.sm, flexShrink: 1 },
  notice: { padding: theme.spacing[4] },
  noticeText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  body: { flex: 1, flexDirection: "row" },
  bodyCompact: { flexDirection: "column" },
  fleet: {
    width: 260,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  fleetCompact: {
    width: "100%",
    maxHeight: 220,
    borderRightWidth: 0,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  fleetContent: { padding: theme.spacing[3], gap: theme.spacing[2] },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[2],
  },
  card: {
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    gap: theme.spacing[1],
  },
  cardSelected: { borderColor: theme.colors.accent, backgroundColor: theme.colors.surface2 },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  cardTitle: { fontSize: theme.fontSize.base, color: theme.colors.foreground, flexShrink: 1 },
  cardMeta: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  cardFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: theme.spacing[1],
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  dotOn: { backgroundColor: theme.colors.palette.green[500] },
  dotOff: { backgroundColor: theme.colors.foregroundExtraMuted },
  badge: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
  },
  badgeStock: { backgroundColor: theme.colors.surface2 },
  badgeSlim: { backgroundColor: theme.colors.palette.green[100] },
  badgeText: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  detail: { flex: 1, padding: theme.spacing[3], gap: theme.spacing[3] },
  detailEmpty: { flex: 1, alignItems: "center", justifyContent: "center" },
  toolbar: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  toolBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  toolBtnDisabled: { opacity: 0.4 },
  toolBtnText: { fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  toolBtnTextDanger: { color: theme.colors.palette.red[600] },
  stage: {
    flex: 1,
    minHeight: 240,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.md,
    overflow: "hidden",
  },
  screenPressable: { width: "100%", height: "100%" },
  screenImage: { width: "100%", height: "100%" },
  stageHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[4],
  },
  tapHint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  logs: {
    maxHeight: 160,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.md,
  },
  logsContent: { padding: theme.spacing[2] },
  logsText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily?.mono ?? "monospace",
  },
}));
