import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BackHandler, Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { Gesture } from "react-native-gesture-handler";
import { CircleAlert, MessageSquare, Plus, Smartphone } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { Theme } from "@/styles/theme";
import type { SimAction, SimDevice } from "@jagentdesk/protocol/simulator/rpc-schemas";
import { Skeleton, useSkeletonPulse } from "@/components/ui/skeleton";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import { SimChatDock } from "@/components/sim-chat-dock";
import { useSimChatStore } from "@/stores/sim-chat-store";
import { SimAddSheet } from "@/screens/sim-add-sheet";
import { SimDrivePanel } from "@/screens/sim-drive-panel";
import { PhoneScreen, TILE_MAX_DIM, TILE_POLL_MS, useScreenshot } from "@/screens/sim-phone";

// Tiles share one size so rows stay aligned; the device (real aspect) is centered inside.
const FRAME_H = 190;
const CARD_W = 168;
const SKELETON_CARDS = ["a", "b", "c", "d"];
// Detail rail: draggable between these widths; the device grows with it.
const DRIVE_MIN_W = 320;
const DRIVE_MAX_W = 960;
const DRIVE_DEFAULT_W = 420;
const SLIDE_MS = 220;

const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const fg = (theme: Theme) => ({ color: theme.colors.foreground });
const accent = (theme: Theme) => ({ color: theme.colors.accent });
const red600 = (theme: Theme) => ({ color: theme.colors.palette.red[600] });

const ThemedSmartphone = withUnistyles(Smartphone);
const ThemedPlus = withUnistyles(Plus);
const ThemedAlert = withUnistyles(CircleAlert);
const ThemedMessageSquare = withUnistyles(MessageSquare);

function randomId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}`;
}

interface Pending {
  udid: string;
  action: SimAction;
}

function DeviceTile({
  device,
  selected,
  booting,
  client,
  onSelect,
  onBoot,
}: {
  device: SimDevice;
  selected: boolean;
  booting: boolean;
  client: DaemonClient | null;
  onSelect: (udid: string) => void;
  onBoot: (udid: string) => void;
}) {
  const shot = useScreenshot(client, device.udid, device.isBooted, TILE_POLL_MS, TILE_MAX_DIM);
  const select = useCallback(() => onSelect(device.udid), [device.udid, onSelect]);
  const boot = useCallback(() => onBoot(device.udid), [device.udid, onBoot]);

  return (
    <Pressable
      onPress={select}
      style={[styles.card, selected ? styles.cardSelected : null]}
      accessibilityRole="button"
      accessibilityLabel={`Simulator ${device.name}`}
      testID={`sim-tile-${device.udid}`}
    >
      <View style={styles.cardHead}>
        <View style={[styles.dot, device.isBooted ? styles.dotOn : styles.dotOff]} />
        <Text style={styles.cardName} numberOfLines={1}>
          {device.name}
        </Text>
      </View>
      <View style={styles.cardBody}>
        <PhoneScreen
          name={device.name}
          typeName={device.deviceType || device.name}
          booted={device.isBooted}
          booting={booting}
          source={shot?.source ?? null}
          shotAspect={shot?.aspect ?? null}
          maxW={CARD_W - 28}
          maxH={FRAME_H}
          onBoot={boot}
        />
      </View>
      <Text style={styles.cardMeta} numberOfLines={1}>
        {device.runtime}
      </Text>
    </Pressable>
  );
}

// First tile of the grid: always in view, same footprint as a device card.
function AddTile({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={styles.addCard}
      accessibilityRole="button"
      accessibilityLabel="New simulator"
      testID="sim-add-open"
    >
      <View style={styles.addIcon}>
        <ThemedPlus size={20} uniProps={accent} />
      </View>
      <Text style={styles.addTitle}>New simulator</Text>
      <Text style={styles.addSub}>iPhone or iPad, any installed iOS</Text>
    </Pressable>
  );
}

function SkeletonGrid() {
  const pulse = useSkeletonPulse();
  return (
    <>
      {SKELETON_CARDS.map((key) => (
        <View key={key} style={styles.card} testID="sim-skeleton-card">
          <Skeleton width="70%" height={12} pulse={pulse} />
          <View style={styles.cardBody}>
            <Skeleton width={88} height={FRAME_H} radius={16} pulse={pulse} />
          </View>
          <Skeleton width="40%" height={10} pulse={pulse} />
        </View>
      ))}
    </>
  );
}

// Keeps the last device mounted while the panel animates closed, so it slides out with content.
function useLingering<T>(value: T | null, ms: number): T | null {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    if (value) {
      setShown(value);
      return;
    }
    const timer = setTimeout(() => setShown(null), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return value ?? shown;
}

function useSimFleet(client: DaemonClient | null) {
  const [availability, setAvailability] = useState({
    simctl: true,
    idb: false,
    maestro: false,
    xcode: false,
  });
  const [devices, setDevices] = useState<SimDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Stay in the loading state until the first fleet snapshot (or a real failure) arrives — a
  // host client that is still connecting is not "loaded with zero devices".
  useEffect(() => {
    setLoading(true);
    if (!client) return;
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

  // The fleet push only sweeps every few seconds; after our own change, refresh right away so the
  // UI never lingers on the old state.
  const refresh = useCallback(async () => {
    if (!client) return;
    try {
      const res = await client.simulatorList();
      if (!res.error) setDevices(res.devices);
    } catch {
      /* the next fleet push catches up */
    }
  }, [client]);

  return { availability, devices, loading, error, setError, refresh };
}

// Desktop detail rail: animated open/close + drag-to-resize; the device grows with the rail.
function useDriveRail(open: boolean) {
  const [driveWidth, setDriveWidth] = useState(DRIVE_DEFAULT_W);
  const driveW = useSharedValue(open ? DRIVE_DEFAULT_W : 0);
  const wasOpen = useRef(open);
  useEffect(() => {
    const toggled = wasOpen.current !== open;
    wasOpen.current = open;
    const to = open ? driveWidth : 0;
    driveW.value = toggled ? withTiming(to, { duration: SLIDE_MS }) : to;
  }, [open, driveWidth, driveW]);
  const driveAnim = useAnimatedStyle(() => ({ width: driveW.value }));
  const dragStart = useRef(driveWidth);
  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .onStart(() => {
          dragStart.current = driveWidth;
        })
        .onUpdate((event) => {
          const next = Math.max(
            DRIVE_MIN_W,
            Math.min(DRIVE_MAX_W, dragStart.current - event.translationX),
          );
          driveW.value = next;
          runOnJS(setDriveWidth)(next);
        }),
    [driveWidth, driveW],
  );
  const driveInner = useMemo(() => [styles.driveInner, { width: driveWidth }], [driveWidth]);
  return { driveAnim, resizeGesture, driveInner };
}

// Phone detail: slides in from the right over the fleet; hardware back closes it.
function useDriveSheet(open: boolean, screenWidth: number, close: () => void) {
  const slideX = useSharedValue(open ? 0 : screenWidth);
  useEffect(() => {
    slideX.value = withTiming(open ? 0 : screenWidth, { duration: SLIDE_MS });
  }, [open, screenWidth, slideX]);
  const slideAnim = useAnimatedStyle(() => ({ transform: [{ translateX: slideX.value }] }));
  useEffect(() => {
    if (!open) return;
    const handler = BackHandler.addEventListener("hardwareBackPress", () => {
      close();
      return true;
    });
    return () => handler.remove();
  }, [open, close]);
  return slideAnim;
}

function FleetHeader({
  loading,
  devices,
  showAgentToggle,
}: {
  loading: boolean;
  devices: readonly SimDevice[];
  showAgentToggle: boolean;
}) {
  const chatOpen = useSimChatStore((s) => s.open);
  const showChat = useSimChatStore((s) => s.showChat);
  const hideChat = useSimChatStore((s) => s.hideChat);
  const toggleChat = useCallback(
    () => (chatOpen ? hideChat() : showChat()),
    [chatOpen, hideChat, showChat],
  );
  const booted = devices.filter((d) => d.isBooted).length;
  return (
    <View style={styles.header}>
      <ThemedSmartphone size={18} uniProps={fg} />
      <Text style={styles.headerTitle}>SimFleet</Text>
      {loading ? (
        <Skeleton width={120} height={12} style={styles.headerCountSkeleton} />
      ) : (
        <Text style={styles.headerCount}>
          {devices.length} devices · {booted} booted
        </Text>
      )}
      {showAgentToggle ? (
        <Pressable
          onPress={toggleChat}
          style={[styles.headerBtn, chatOpen ? styles.headerBtnActive : null]}
          accessibilityLabel={chatOpen ? "Hide agent" : "Show agent"}
          testID="sim-chat-toggle"
        >
          <ThemedMessageSquare size={15} uniProps={chatOpen ? fg : muted} />
          <Text style={styles.headerBtnText}>Agent</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function FleetBanners({ error, unavailable }: { error: string | null; unavailable: boolean }) {
  return (
    <>
      {error ? (
        <View style={styles.errorBar}>
          <ThemedAlert size={14} uniProps={red600} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}
      {unavailable ? (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>
            iOS simulators are unavailable on this host. SimFleet needs macOS with Xcode (and idb or
            Maestro for tap/type control).
          </Text>
        </View>
      ) : null}
    </>
  );
}

function isBooting(device: SimDevice, pending: Pending | null): boolean {
  if (device.state === "Booting") return true;
  return pending?.udid === device.udid && pending.action === "boot" && !device.isBooted;
}

function FleetGrid({
  loading,
  available,
  devices,
  selectedUdid,
  pending,
  client,
  onSelect,
  onBoot,
  onAdd,
}: {
  loading: boolean;
  available: boolean;
  devices: readonly SimDevice[];
  selectedUdid: string | null;
  pending: Pending | null;
  client: DaemonClient | null;
  onSelect: (udid: string) => void;
  onBoot: (udid: string) => void;
  onAdd: () => void;
}) {
  if (loading) {
    return (
      <ScrollView style={styles.gridScroll} contentContainerStyle={styles.grid}>
        <SkeletonGrid />
      </ScrollView>
    );
  }
  return (
    <ScrollView style={styles.gridScroll} contentContainerStyle={styles.grid}>
      {available ? <AddTile onPress={onAdd} /> : null}
      {available && devices.length === 0 ? (
        <Text style={styles.empty}>No simulators yet — create one to get started.</Text>
      ) : null}
      {devices.map((device) => (
        <DeviceTile
          key={device.udid}
          device={device}
          selected={device.udid === selectedUdid}
          booting={isBooting(device, pending)}
          client={client}
          onSelect={onSelect}
          onBoot={onBoot}
        />
      ))}
    </ScrollView>
  );
}

export function SimFleetScreen() {
  const hosts = useHosts();
  const serverId = hosts[0]?.serverId ?? "";
  const client = useHostRuntimeClient(serverId);
  const insets = useSafeAreaInsets();
  const isCompact = useIsCompactFormFactor();
  const { width: screenWidth } = useWindowDimensions();

  const { availability, devices, loading, error, setError, refresh } = useSimFleet(client);
  const [selectedUdid, setSelectedUdid] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [adding, setAdding] = useState(false);

  const resetForServer = useSimChatStore((s) => s.resetForServer);
  const applyDefaultOpen = useSimChatStore((s) => s.applyDefaultOpen);
  useEffect(() => {
    if (serverId) resetForServer(serverId);
  }, [serverId, resetForServer]);
  // The agent dock starts open beside the fleet on desktop; on phones it would cover the fleet,
  // so it starts closed behind its floating button. After that the user's choice sticks.
  useEffect(() => applyDefaultOpen(!isCompact), [applyDefaultOpen, isCompact]);

  const selected = useMemo(
    () => devices.find((d) => d.udid === selectedUdid) ?? null,
    [devices, selectedUdid],
  );
  const shownDevice = useLingering(selected, SLIDE_MS);
  const existingNames = useMemo(() => devices.map((d) => d.name), [devices]);

  const runAction = useCallback(
    async (udid: string, action: SimAction) => {
      if (!client) return;
      setPending({ udid, action });
      setError(null);
      try {
        const res = await client.simulatorAction({ udid, action });
        if (res.error) setError(res.error);
        if (action === "delete" && selectedUdid === udid) setSelectedUdid(null);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Action failed");
      } finally {
        await refresh();
        setPending(null);
      }
    },
    [client, selectedUdid, refresh, setError],
  );
  const onBoot = useCallback((udid: string) => void runAction(udid, "boot"), [runAction]);
  const onSelect = useCallback((udid: string) => setSelectedUdid(udid), []);
  const onClose = useCallback(() => setSelectedUdid(null), []);
  const openAdd = useCallback(() => setAdding(true), []);
  const closeAdd = useCallback(() => setAdding(false), []);
  const onCreated = useCallback(
    (udids: string[]) => {
      void refresh();
      if (udids[0]) setSelectedUdid(udids[0]);
    },
    [refresh],
  );

  const pressButton = useCallback(
    async (button: "home" | "lock") => {
      if (!client || !selected) return;
      try {
        await client.simulatorButton({ udid: selected.udid, button });
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Button failed");
      }
    },
    [client, selected, setError],
  );

  const { driveAnim, resizeGesture, driveInner } = useDriveRail(Boolean(selected));
  const slideAnim = useDriveSheet(Boolean(selected) && isCompact, screenWidth, onClose);

  const containerStyle = useMemo(
    () => [styles.screen, isCompact ? { paddingTop: insets.top } : null],
    [isCompact, insets.top],
  );

  const drivePanel = shownDevice ? (
    <SimDrivePanel
      device={shownDevice}
      hidAvailable={availability.idb || availability.maestro}
      idbAvailable={availability.idb}
      pendingAction={pending?.udid === shownDevice.udid ? pending.action : null}
      client={client}
      onClose={onClose}
      onAction={runAction}
      onButton={pressButton}
    />
  ) : null;

  return (
    <View style={containerStyle}>
      <FleetHeader loading={loading} devices={devices} showAgentToggle={!isCompact} />
      <FleetBanners error={error} unavailable={!loading && !availability.simctl} />

      <View style={styles.body}>
        <FleetGrid
          loading={loading}
          available={availability.simctl}
          devices={devices}
          selectedUdid={selectedUdid}
          pending={pending}
          client={client}
          onSelect={onSelect}
          onBoot={onBoot}
          onAdd={openAdd}
        />

        {!isCompact ? (
          <Animated.View
            style={[styles.driveRail, shownDevice ? null : styles.driveRailClosed, driveAnim]}
          >
            {shownDevice ? (
              <SidebarResizeHandle edge="left" gesture={resizeGesture} testID="sim-drive-resize" />
            ) : null}
            <View style={driveInner}>{drivePanel}</View>
          </Animated.View>
        ) : null}

        {serverId ? (
          <SimChatDock serverId={serverId} devices={devices} selected={selected} />
        ) : null}

        {isCompact && shownDevice ? (
          <Animated.View style={[styles.driveSheet, slideAnim]}>{drivePanel}</Animated.View>
        ) : null}
      </View>

      <SimAddSheet
        visible={adding}
        client={client}
        existingNames={existingNames}
        onClose={closeAdd}
        onCreated={onCreated}
      />
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
  headerCountSkeleton: { marginLeft: "auto" },
  headerBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  headerBtnActive: { backgroundColor: theme.colors.surface2 },
  headerBtnText: { fontSize: theme.fontSize.sm, color: theme.colors.foreground },
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
  body: { flex: 1, flexDirection: "row", minHeight: 0 },
  gridScroll: { flex: 1 },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[4],
    padding: theme.spacing[4],
    alignItems: "flex-start",
  },
  empty: {
    alignSelf: "center",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  card: {
    width: CARD_W,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing[2],
    gap: theme.spacing[2],
  },
  cardSelected: { borderColor: theme.colors.accent, backgroundColor: theme.colors.surface2 },
  cardHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
  },
  cardName: { flex: 1, fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  cardBody: { height: FRAME_H, alignItems: "center", justifyContent: "center" },
  cardMeta: {
    paddingHorizontal: theme.spacing[1],
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  addCard: {
    width: CARD_W,
    height: FRAME_H + 64,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
  },
  addIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface2,
  },
  addTitle: { fontSize: theme.fontSize.sm, fontWeight: "600", color: theme.colors.foreground },
  addSub: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  dotOn: { backgroundColor: theme.colors.palette.green[500] },
  dotOff: { backgroundColor: theme.colors.foregroundExtraMuted },
  driveRail: {
    height: "100%",
    overflow: "hidden",
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  driveRailClosed: { borderLeftWidth: 0 },
  driveInner: { flex: 1, height: "100%" },
  driveSheet: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.colors.surface1,
    zIndex: 30,
  },
}));
