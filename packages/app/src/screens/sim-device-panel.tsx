import { useCallback, useMemo, useRef, useState } from "react";
import {
  type GestureResponderEvent,
  type GestureResponderHandlers,
  type LayoutChangeEvent,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  ArrowLeft,
  House,
  LayoutGrid,
  Lock,
  Power,
  RotateCw,
  Send,
  ShieldCheck,
  ShieldOff,
  Volume1,
  Volume2,
  Wrench,
  X,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type {
  SimButton,
  SimDevice,
  SimSignerAccount,
} from "@jagentdesk/protocol/simulator/rpc-schemas";
import { Button } from "@/components/ui/button";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { confirmDialog } from "@/utils/confirm-dialog";
import type { Theme } from "@/styles/theme";
import { LogsTab, useDeviceLogs } from "@/screens/sim-drive-panel";
import {
  DRIVE_LIVE_FPS,
  DRIVE_MAX_DIM,
  DRIVE_POLL_MS,
  PhoneScreen,
  isDeviceLive,
  useDeviceScreen,
} from "@/screens/sim-phone";
import { READINESS_COPY, connectionLabel, deviceErrorCopy } from "@/screens/sim-device-errors";

// Detail rail / sheet for a physical device or adb emulator (spec 27): the control switch, the
// readiness steps, iOS Prepare device, and a live screen driven by tap, long press and swipe.

const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedX = withUnistyles(X);

type Tab = "screen" | "logs";
const TABS: SegmentedControlOption<Tab>[] = [
  { value: "screen", label: "Screen", testID: "device-tab-screen" },
  { value: "logs", label: "Logs", testID: "device-tab-logs" },
];

const TAP_SLOP_PX = 8;
const LONG_PRESS_MS = 450;

interface ButtonSpec {
  button: SimButton;
  label: string;
  icon: typeof House;
}

const ANDROID_BUTTONS: ButtonSpec[] = [
  { button: "home", label: "Home", icon: House },
  { button: "back", label: "Back", icon: ArrowLeft },
  { button: "app-switch", label: "Recents", icon: LayoutGrid },
  { button: "volume-down", label: "Vol −", icon: Volume1 },
  { button: "volume-up", label: "Vol +", icon: Volume2 },
  { button: "power", label: "Power", icon: Power },
  { button: "rotate", label: "Rotate", icon: RotateCw },
];

const IOS_BUTTONS: ButtonSpec[] = [
  { button: "home", label: "Home", icon: House },
  { button: "lock", label: "Lock", icon: Lock },
  { button: "volume-down", label: "Vol −", icon: Volume1 },
  { button: "volume-up", label: "Vol +", icon: Volume2 },
];

type Pending = "enable" | "disable" | "prepare" | "type" | SimButton | null;

function clampRatio(value: number): number {
  return Math.min(1, Math.max(0, value));
}

// Raw touches on the screen → ratio coordinates (spec 27.5): a short touch taps, a held one long
// presses, a moved one swipes over the time the finger took.
function useScreenGestures(
  client: DaemonClient | null,
  udid: string,
  onError: (message: string) => void,
): { gestures: GestureResponderHandlers; onLayout: (e: LayoutChangeEvent) => void } {
  const layout = useRef({ w: 0, h: 0 });
  const start = useRef<{ x: number; y: number; t: number } | null>(null);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    layout.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height };
  }, []);
  const gestures = useMemo<GestureResponderHandlers>(
    () => ({
      onStartShouldSetResponder: () => true,
      onMoveShouldSetResponder: () => true,
      onResponderGrant: (e: GestureResponderEvent) => {
        start.current = { x: e.nativeEvent.locationX, y: e.nativeEvent.locationY, t: Date.now() };
      },
      onResponderRelease: (e: GestureResponderEvent) => {
        const from = start.current;
        start.current = null;
        const { w, h } = layout.current;
        if (!client || !from || !w || !h) return;
        const to = { x: e.nativeEvent.locationX, y: e.nativeEvent.locationY };
        const elapsed = Date.now() - from.t;
        const moved = Math.hypot(to.x - from.x, to.y - from.y) > TAP_SLOP_PX;
        const a = { x: clampRatio(from.x / w), y: clampRatio(from.y / h) };
        const b = { x: clampRatio(to.x / w), y: clampRatio(to.y / h) };
        const fail = (err: unknown) => onError(err instanceof Error ? err.message : String(err));
        const report = (res: { error: string | null }) => {
          if (res.error) onError(deviceErrorCopy(res.error));
          return undefined;
        };
        if (!moved && elapsed < LONG_PRESS_MS) {
          void client.simulatorTap({ udid, x: a.x, y: a.y, coords: "ratio" }).then(report, fail);
          return;
        }
        const durationMs = Math.min(2000, Math.max(80, elapsed));
        const end = moved ? b : a;
        void client
          .simulatorSwipe({
            udid,
            x1: a.x,
            y1: a.y,
            x2: end.x,
            y2: end.y,
            durationMs,
            coords: "ratio",
          })
          .then(report, fail);
      },
      onResponderTerminate: () => {
        start.current = null;
      },
    }),
    [client, udid, onError],
  );
  return { gestures, onLayout };
}

function ControlOffCard({
  device,
  pending,
  onEnable,
}: {
  device: SimDevice;
  pending: Pending;
  onEnable: () => void;
}) {
  return (
    <View style={styles.card} testID="device-control-off">
      <Text style={styles.cardTitle}>Control is off</Text>
      <Text style={styles.cardText}>
        Nothing on {device.name} is captured or driven until you enable control: no screen, logs,
        taps or installs. Only its name, model, OS and connection are shown.
      </Text>
      <View style={styles.row}>
        <Button
          size="sm"
          leftIcon={ShieldCheck}
          onPress={onEnable}
          loading={pending === "enable"}
          disabled={pending !== null}
          testID="device-enable-control"
        >
          Enable control
        </Button>
      </View>
    </View>
  );
}

function PrepareSection({
  client,
  device,
  onError,
}: {
  client: DaemonClient | null;
  device: SimDevice;
  onError: (message: string | null) => void;
}) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<SimSignerAccount[]>([]);
  const prepare = useCallback(
    async (accountId?: string) => {
      if (!client) return;
      setRunning(true);
      setAccounts([]);
      onError(null);
      const requestId = `prepare-${Math.random().toString(36).slice(2)}`;
      const off = client.onSimulatorPrepareProgress(requestId, (p) => setProgress(p.message));
      try {
        const res = await client.simulatorPhysicalPrepare({
          udid: device.udid,
          accountId,
          requestId,
        });
        if (res.error === "account_required") setAccounts(res.accounts);
        if (res.error) onError(deviceErrorCopy(res.error));
      } catch (err) {
        onError(err instanceof Error ? err.message : "Prepare failed");
      } finally {
        off();
        setRunning(false);
        setProgress(null);
      }
    },
    [client, device.udid, onError],
  );
  const start = useCallback(() => void prepare(), [prepare]);
  return (
    <View style={styles.prepare}>
      <View style={styles.row}>
        <Button
          size="sm"
          leftIcon={Wrench}
          onPress={start}
          loading={running}
          disabled={running}
          testID="device-prepare"
        >
          Prepare device
        </Button>
        {progress ? <Text style={styles.hint}>{progress}</Text> : null}
      </View>
      {accounts.length > 0 ? (
        <View style={styles.row}>
          {accounts.map((account) => (
            <AccountChoice key={account.id} account={account} onChoose={prepare} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function AccountChoice({
  account,
  onChoose,
}: {
  account: SimSignerAccount;
  onChoose: (accountId: string) => Promise<void>;
}) {
  const choose = useCallback(() => void onChoose(account.id), [account.id, onChoose]);
  return (
    <Button size="sm" variant="outline" onPress={choose}>
      {account.label}
    </Button>
  );
}

function ReadinessCard({
  client,
  device,
  onError,
}: {
  client: DaemonClient | null;
  device: SimDevice;
  onError: (message: string | null) => void;
}) {
  const readiness = device.readiness ?? "ready";
  if (readiness === "ready") return null;
  const canPrepare =
    device.platform === "ios" && (readiness === "needs_wda" || readiness === "wda_expired");
  return (
    <View style={styles.card} testID={`device-readiness-${readiness}`}>
      <Text style={styles.cardTitle}>Device needs attention</Text>
      <Text style={styles.cardText}>{READINESS_COPY[readiness]}</Text>
      {canPrepare ? <PrepareSection client={client} device={device} onError={onError} /> : null}
    </View>
  );
}

function HardwareButtons({
  device,
  pending,
  onPress,
}: {
  device: SimDevice;
  pending: Pending;
  onPress: (button: SimButton) => void;
}) {
  const buttons = device.platform === "ios" ? IOS_BUTTONS : ANDROID_BUTTONS;
  return (
    <View style={styles.row}>
      {buttons.map((spec) => (
        <HardwareButton key={spec.button} spec={spec} pending={pending} onPress={onPress} />
      ))}
    </View>
  );
}

function HardwareButton({
  spec,
  pending,
  onPress,
}: {
  spec: ButtonSpec;
  pending: Pending;
  onPress: (button: SimButton) => void;
}) {
  const press = useCallback(() => onPress(spec.button), [onPress, spec.button]);
  return (
    <Button
      size="sm"
      variant="outline"
      leftIcon={spec.icon}
      onPress={press}
      loading={pending === spec.button}
      testID={`device-button-${spec.button}`}
    >
      {spec.label}
    </Button>
  );
}

function TypeBar({ onSend, pending }: { onSend: (text: string) => void; pending: Pending }) {
  const [text, setText] = useState("");
  const send = useCallback(() => {
    if (!text) return;
    onSend(text);
    setText("");
  }, [onSend, text]);
  return (
    <View style={styles.typeRow}>
      <TextInput
        value={text}
        onChangeText={setText}
        onSubmitEditing={send}
        placeholder="Type into the focused field"
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.typeInput}
        testID="device-type-input"
      />
      <Button
        size="sm"
        leftIcon={Send}
        onPress={send}
        loading={pending === "type"}
        disabled={!text}
        testID="device-type-send"
      >
        Send
      </Button>
    </View>
  );
}

export function SimDevicePanel({
  device,
  client,
  onClose,
  onChanged,
}: {
  device: SimDevice;
  client: DaemonClient | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<Tab>("screen");
  const [pending, setPending] = useState<Pending>(null);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const live = isDeviceLive(device);
  const screen = useDeviceScreen(client, device, {
    maxFps: DRIVE_LIVE_FPS,
    pollMs: DRIVE_POLL_MS,
    maxDim: DRIVE_MAX_DIM,
  });
  const logs = useDeviceLogs(client, device.udid, live);
  const reportError = useCallback((message: string) => setError(message), []);
  const { gestures, onLayout } = useScreenGestures(client, device.udid, reportError);
  const enabled = device.controlEnabled === true;

  const run = useCallback(
    async (key: Pending, action: () => Promise<{ error: string | null }>) => {
      setPending(key);
      setError(null);
      try {
        const res = await action();
        if (res.error) setError(deviceErrorCopy(res.error));
      } catch (err) {
        setError(err instanceof Error ? err.message : "The action failed");
      } finally {
        setPending(null);
        onChanged();
      }
    },
    [onChanged],
  );

  const enable = useCallback(() => {
    if (!client) return;
    void confirmDialog({
      title: `Enable control of ${device.name}?`,
      message:
        "Every paired client and every agent you allow can then see this device's screen and control it: tap, type, read its logs and install apps. Turn control off at any time.",
      confirmLabel: "Enable control",
    }).then((ok) => {
      if (ok) void run("enable", () => client.simulatorPhysicalEnable({ udid: device.udid }));
      return undefined;
    });
  }, [client, device.name, device.udid, run]);
  const disable = useCallback(() => {
    if (!client) return;
    void run("disable", () => client.simulatorPhysicalDisable({ udid: device.udid }));
  }, [client, device.udid, run]);
  const press = useCallback(
    (button: SimButton) => {
      if (!client) return;
      void run(button, () => client.simulatorButton({ udid: device.udid, button }));
    },
    [client, device.udid, run],
  );
  const type = useCallback(
    (text: string) => {
      if (!client) return;
      void run("type", () => client.simulatorInputText({ udid: device.udid, text }));
    },
    [client, device.udid, run],
  );
  const onStageLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setStage((prev) => (prev.w === width && prev.h === height ? prev : { w: width, h: height }));
  }, []);

  const subtitle = [device.model || device.deviceType, device.runtime, connectionLabel(device)]
    .filter(Boolean)
    .join(" · ");
  let screenStatus = "Waiting for the first frame";
  if (screen.mode === "live") screenStatus = `Live · ${screen.fps ?? 0} fps`;
  if (screen.mode === "poll") screenStatus = "Screenshots (live stream unavailable)";

  return (
    <View style={styles.panel} testID="device-panel">
      <View style={styles.head}>
        <View style={styles.titleWrap}>
          <Text style={styles.title} numberOfLines={1}>
            {device.name}
          </Text>
          <Text style={styles.sub} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
        <Pressable onPress={onClose} accessibilityLabel="Close" hitSlop={8} style={styles.iconBtn}>
          <ThemedX size={16} uniProps={muted} />
        </Pressable>
      </View>

      {enabled ? null : <ControlOffCard device={device} pending={pending} onEnable={enable} />}
      {enabled ? (
        <View style={styles.row}>
          <Button
            size="sm"
            variant="outline"
            leftIcon={ShieldOff}
            onPress={disable}
            loading={pending === "disable"}
            disabled={pending !== null}
            testID="device-disable-control"
          >
            Disable control
          </Button>
        </View>
      ) : null}
      {enabled ? <ReadinessCard client={client} device={device} onError={setError} /> : null}
      {error ? (
        <Text style={styles.error} testID="device-error">
          {error}
        </Text>
      ) : null}

      {live ? (
        <>
          <SegmentedControl options={TABS} value={tab} onValueChange={setTab} size="sm" />
          {tab === "screen" ? (
            <>
              <HardwareButtons device={device} pending={pending} onPress={press} />
              <View style={styles.stage} onLayout={onStageLayout}>
                {stage.w > 0 ? (
                  <PhoneScreen
                    name={device.name}
                    typeName={device.model || device.deviceType || device.name}
                    booted
                    source={screen.shot?.source ?? null}
                    shotAspect={screen.shot?.aspect ?? null}
                    maxW={stage.w}
                    maxH={stage.h}
                    onLayout={onLayout}
                    gestures={gestures}
                    waitingLabel="Starting the screen…"
                  />
                ) : (
                  <Skeleton width="60%" height="90%" radius={24} />
                )}
              </View>
              <Text style={styles.hint} testID="device-screen-status">
                {screenStatus}. Tap, hold or drag on the screen.
              </Text>
              <TypeBar onSend={type} pending={pending} />
            </>
          ) : (
            <LogsTab logs={logs} active={live} idleText="Enable control to stream logs." />
          )}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  panel: { flex: 1, padding: theme.spacing[3], gap: theme.spacing[3] },
  head: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  titleWrap: { flex: 1 },
  title: { fontSize: theme.fontSize.base, fontWeight: "600", color: theme.colors.foreground },
  sub: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  iconBtn: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  card: {
    padding: theme.spacing[3],
    gap: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  cardTitle: { fontSize: theme.fontSize.sm, fontWeight: "600", color: theme.colors.foreground },
  cardText: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  prepare: { gap: theme.spacing[2] },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.spacing[2] },
  stage: { flex: 1, minHeight: 260, alignItems: "center", justifyContent: "center" },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  typeRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  typeInput: {
    flex: 1,
    minWidth: 0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
}));
