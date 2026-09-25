import { useCallback, useEffect, useRef, useState } from "react";
import {
  type GestureResponderEvent,
  type LayoutChangeEvent,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { House, Lock, Play, RefreshCw, Square, Trash2, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { SimAction, SimDevice } from "@jagentdesk/protocol/simulator/rpc-schemas";
import { Button } from "@/components/ui/button";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { Skeleton, SkeletonLines } from "@/components/ui/skeleton";
import { confirmDialog } from "@/utils/confirm-dialog";
import type { Theme } from "@/styles/theme";
import { DRIVE_MAX_DIM, DRIVE_POLL_MS, PhoneScreen, useScreenshot } from "@/screens/sim-phone";

const LOG_CAP = 40_000;
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedX = withUnistyles(X);

type DriveTab = "screen" | "logs";
const TABS: SegmentedControlOption<DriveTab>[] = [
  { value: "screen", label: "Screen", testID: "sim-tab-screen" },
  { value: "logs", label: "Logs", testID: "sim-tab-logs" },
];

function randomId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}`;
}

// Touch input maps a click on the frame to device POINTS; the point size comes from the element
// tree (idb/Maestro), which can take a while on the first call while Maestro starts its driver.
type TouchState = "unavailable" | "preparing" | "ready" | "failed";

function useTouchMapping(
  client: DaemonClient | null,
  device: SimDevice,
  hidAvailable: boolean,
): { state: TouchState; point: { w: number; h: number } | null } {
  const [point, setPoint] = useState<{ w: number; h: number } | null>(null);
  const [state, setState] = useState<TouchState>("unavailable");
  useEffect(() => {
    setPoint(null);
    if (!client || !device.isBooted || !hidAvailable) {
      setState("unavailable");
      return;
    }
    setState("preparing");
    let cancelled = false;
    void (async () => {
      try {
        const res = await client.simulatorDescribeUi({ udid: device.udid });
        if (cancelled) return;
        let w = 0;
        let h = 0;
        for (const el of res.elements) {
          w = Math.max(w, el.x + el.width);
          h = Math.max(h, el.y + el.height);
        }
        if (w > 0 && h > 0) {
          setPoint({ w, h });
          setState("ready");
        } else {
          setState("failed");
        }
      } catch {
        if (!cancelled) setState("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, device.udid, device.isBooted, hidAvailable]);
  return { state, point };
}

function useDeviceLogs(client: DaemonClient | null, device: SimDevice): string {
  const [logs, setLogs] = useState("");
  useEffect(() => {
    setLogs("");
    if (!client || !device.isBooted) return;
    const udid = device.udid;
    let cancelled = false;
    const subId = randomId("sim-log");
    const off = client.onSimulatorLogChunk(subId, (chunk) => {
      if (!cancelled) setLogs((prev) => (prev + chunk.chunk).slice(-LOG_CAP));
    });
    void client.simulatorLogsSubscribe({ subscriptionId: subId, udid }).catch(() => {});
    return () => {
      cancelled = true;
      off();
      client.simulatorLogsUnsubscribe({ subscriptionId: subId });
    };
  }, [client, device.udid, device.isBooted]);
  return logs;
}

const TOUCH_HINT: Record<TouchState, string | null> = {
  unavailable: null,
  preparing: "Preparing touch input…",
  ready: "Click the screen to tap the device.",
  failed: "Touch input unavailable for this device right now.",
};

// Right-rail (desktop) / full-screen (phone) detail for one simulator: a live, tappable device on
// the Screen tab and its streaming system log on the Logs tab.
export function SimDrivePanel({
  device,
  hidAvailable,
  idbAvailable,
  pendingAction,
  client,
  onClose,
  onAction,
  onButton,
}: {
  device: SimDevice;
  hidAvailable: boolean;
  idbAvailable: boolean;
  pendingAction: SimAction | null;
  client: DaemonClient | null;
  onClose: () => void;
  onAction: (udid: string, action: SimAction) => void;
  onButton: (button: "home" | "lock") => void;
}) {
  const [tab, setTab] = useState<DriveTab>("screen");
  const shot = useScreenshot(client, device.udid, device.isBooted, DRIVE_POLL_MS, DRIVE_MAX_DIM);
  const touch = useTouchMapping(client, device, hidAvailable);
  const logs = useDeviceLogs(client, device);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const imgLayout = useRef({ w: 0, h: 0 });
  const busy = pendingAction !== null;

  const boot = useCallback(() => onAction(device.udid, "boot"), [device.udid, onAction]);
  const shutdown = useCallback(() => onAction(device.udid, "shutdown"), [device.udid, onAction]);
  const erase = useCallback(() => {
    void confirmDialog({
      title: `Erase ${device.name}?`,
      message: "All apps, data and settings on this simulator are wiped.",
      confirmLabel: "Erase",
      destructive: true,
    }).then((ok) => {
      if (ok) onAction(device.udid, "erase");
      return undefined;
    });
  }, [device.name, device.udid, onAction]);
  const del = useCallback(() => {
    void confirmDialog({
      title: `Delete ${device.name}?`,
      message: "The simulator and everything on it is removed permanently.",
      confirmLabel: "Delete",
      destructive: true,
    }).then((ok) => {
      if (ok) onAction(device.udid, "delete");
      return undefined;
    });
  }, [device.name, device.udid, onAction]);
  const home = useCallback(() => onButton("home"), [onButton]);
  const lock = useCallback(() => onButton("lock"), [onButton]);

  const onStageLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setStage((prev) => (prev.w === width && prev.h === height ? prev : { w: width, h: height }));
  }, []);
  const onImageLayout = useCallback((e: LayoutChangeEvent) => {
    imgLayout.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height };
  }, []);
  const onScreenTap = useCallback(
    (e: GestureResponderEvent) => {
      if (!client || !touch.point) return;
      const { locationX, locationY } = e.nativeEvent;
      const { w, h } = imgLayout.current;
      if (!w || !h) return;
      void client
        .simulatorTap({
          udid: device.udid,
          x: (locationX / w) * touch.point.w,
          y: (locationY / h) * touch.point.h,
        })
        .catch(() => {});
    },
    [client, device.udid, touch.point],
  );

  let hint = TOUCH_HINT[touch.state];
  if (device.isBooted && !hidAvailable) hint = "Install idb or Maestro to tap and type here.";
  const booting = pendingAction === "boot" && !device.isBooted;

  return (
    <View style={styles.drive}>
      <View style={styles.head}>
        <View style={styles.titleWrap}>
          <Text style={styles.title} numberOfLines={1}>
            {device.name}
          </Text>
          <Text style={styles.sub} numberOfLines={1}>
            {device.deviceType} · {device.runtime} · {device.state}
          </Text>
        </View>
        <Pressable
          onPress={onClose}
          accessibilityLabel="Close"
          hitSlop={8}
          style={styles.iconBtn}
          testID="sim-drive-close"
        >
          <ThemedX size={16} uniProps={muted} />
        </Pressable>
      </View>

      <SegmentedControl options={TABS} value={tab} onValueChange={setTab} size="sm" />

      {tab === "screen" ? (
        <>
          <View style={styles.toolbar}>
            {device.isBooted ? (
              <Button
                size="sm"
                leftIcon={Square}
                onPress={shutdown}
                disabled={busy}
                loading={pendingAction === "shutdown"}
              >
                Shutdown
              </Button>
            ) : (
              <Button size="sm" leftIcon={Play} onPress={boot} disabled={busy} loading={booting}>
                Boot
              </Button>
            )}
            <Button
              size="sm"
              leftIcon={House}
              onPress={home}
              disabled={!device.isBooted || !idbAvailable}
            >
              Home
            </Button>
            <Button
              size="sm"
              leftIcon={Lock}
              onPress={lock}
              disabled={!device.isBooted || !idbAvailable}
            >
              Lock
            </Button>
            <Button
              size="sm"
              leftIcon={RefreshCw}
              onPress={erase}
              disabled={busy}
              loading={pendingAction === "erase"}
            >
              Erase
            </Button>
            <Button
              size="sm"
              variant="destructive"
              leftIcon={Trash2}
              onPress={del}
              disabled={busy}
              loading={pendingAction === "delete"}
            >
              Delete
            </Button>
          </View>

          <View style={styles.stage} onLayout={onStageLayout}>
            {stage.w > 0 ? (
              <PhoneScreen
                name={device.name}
                typeName={device.deviceType || device.name}
                booted={device.isBooted}
                booting={booting}
                source={shot?.source ?? null}
                shotAspect={shot?.aspect ?? null}
                maxW={stage.w}
                maxH={stage.h}
                onLayout={onImageLayout}
                onTap={touch.state === "ready" ? onScreenTap : undefined}
              />
            ) : (
              <Skeleton width="60%" height="90%" radius={24} />
            )}
          </View>

          {hint ? <Text style={styles.hint}>{hint}</Text> : null}
        </>
      ) : (
        <LogsTab logs={logs} booted={device.isBooted} />
      )}
    </View>
  );
}

function LogsTab({ logs, booted }: { logs: string; booted: boolean }) {
  const scrollRef = useRef<ScrollView>(null);
  // Follow the tail like `log stream` does.
  const onContentSizeChange = useCallback(() => {
    scrollRef.current?.scrollToEnd({ animated: false });
  }, []);
  if (!booted) {
    return <Text style={styles.hint}>Boot the simulator to stream its logs.</Text>;
  }
  if (!logs) {
    return (
      <View style={styles.logsWaiting}>
        <Text style={styles.hint}>Waiting for log output…</Text>
        <SkeletonLines count={8} lineHeight={10} />
      </View>
    );
  }
  return (
    <ScrollView
      ref={scrollRef}
      style={styles.logs}
      contentContainerStyle={styles.logsContent}
      onContentSizeChange={onContentSizeChange}
      testID="sim-logs"
    >
      <Text style={styles.logsText} selectable>
        {logs}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  drive: { flex: 1, padding: theme.spacing[3], gap: theme.spacing[3] },
  head: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  titleWrap: { flex: 1 },
  title: { fontSize: theme.fontSize.base, fontWeight: "600", color: theme.colors.foreground },
  sub: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  iconBtn: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  toolbar: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  stage: { flex: 1, minHeight: 260, alignItems: "center", justifyContent: "center" },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  logsWaiting: { gap: theme.spacing[3] },
  logs: {
    flex: 1,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
  },
  logsContent: { padding: theme.spacing[2] },
  logsText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily?.mono ?? "monospace",
  },
}));
