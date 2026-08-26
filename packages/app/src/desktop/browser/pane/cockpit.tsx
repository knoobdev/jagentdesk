import { useCallback, useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Check, ChevronRight, KeyRound, Loader, Shield, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useShallow } from "zustand/shallow";
import { useBrowserActivityStore, type BrowserStep } from "@/desktop/browser/automation/activity-store";
import { useBrowserStealthStore } from "@/desktop/browser/stealth-store";
import type { Theme } from "@/styles/theme";

const ThemedShield = withUnistyles(Shield);
const ThemedKey = withUnistyles(KeyRound);
const ThemedCheck = withUnistyles(Check);
const ThemedX = withUnistyles(X);
const ThemedLoader = withUnistyles(Loader);
const ThemedChevron = withUnistyles(ChevronRight);

const okColor = (theme: Theme) => ({ color: theme.colors.palette.green[500] });
const errColor = (theme: Theme) => ({ color: theme.colors.palette.red[500] });
const accentColor = (theme: Theme) => ({ color: theme.colors.accent });
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function useSteps(browserId: string): BrowserStep[] {
  return useBrowserActivityStore(useShallow((state) => state.stepsByBrowser[browserId] ?? EMPTY));
}
const EMPTY: BrowserStep[] = [];

export function useAgentDriving(browserId: string): boolean {
  return useBrowserActivityStore((state) =>
    (state.stepsByBrowser[browserId] ?? EMPTY).some((s) => s.status === "running"),
  );
}

function StepIcon({ status }: { status: BrowserStep["status"] }) {
  if (status === "done") {
    return <ThemedCheck size={13} uniProps={okColor} />;
  }
  if (status === "failed") {
    return <ThemedX size={13} uniProps={errColor} />;
  }
  return <ThemedLoader size={13} uniProps={accentColor} />;
}

function StepRow({ step, isLast }: { step: BrowserStep; isLast: boolean }) {
  return (
    <View style={styles.stepRow}>
      <View style={styles.stepRail}>
        <View style={styles.stepDot}>
          <StepIcon status={step.status} />
        </View>
        {isLast ? null : <View style={styles.stepLine} />}
      </View>
      <View style={styles.stepBody}>
        <Text style={step.status === "running" ? styles.stepLabelActive : styles.stepLabel}>
          {step.label}
        </Text>
        {step.detail ? (
          <Text style={styles.stepDetail} numberOfLines={1}>
            {step.detail}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** Left cockpit panel: the live step timeline of the agent's browser actions. */
export function BrowserTaskPanel({ browserId, title }: { browserId: string; title: string }) {
  const steps = useSteps(browserId);
  const driving = steps.some((s) => s.status === "running");

  return (
    <View style={styles.panel}>
      <View style={styles.panelHead}>
        <Text style={styles.panelKicker}>AGENTIC BROWSER</Text>
        <Text style={styles.panelTitle} numberOfLines={2}>
          {title || "Browser task"}
        </Text>
        <View style={styles.panelStatusRow}>
          <View style={driving ? styles.driveDotOn : styles.driveDot} />
          <Text style={driving ? styles.driveTextOn : styles.driveText}>
            {driving ? "agent driving" : "idle"}
          </Text>
        </View>
      </View>
      <ScrollView style={styles.stepScroll} contentContainerStyle={styles.stepScrollContent}>
        {steps.length > 0 ? (
          steps.map((step, i) => (
            <StepRow key={step.id} step={step} isLast={i === steps.length - 1} />
          ))
        ) : (
          <Text style={styles.stepEmpty}>
            No browser steps yet. When an agent drives this tab, each navigate, click, and read
            appears here as it happens.
          </Text>
        )}
      </ScrollView>
    </View>
  );
}

/** Top-bar controls: a working Stealth toggle + Connected-logins count. The pill
 *  reflects and drives the REAL stealth state (see stealth-store → main injection). */
export function CockpitControls({ connectedLogins }: { connectedLogins: number }) {
  const stealthOn = useBrowserStealthStore((s) => s.enabled);
  const setEnabled = useBrowserStealthStore((s) => s.setEnabled);
  const toggle = useCallback(() => setEnabled(!stealthOn), [setEnabled, stealthOn]);
  const a11yState = useMemo(() => ({ checked: stealthOn }), [stealthOn]);
  return (
    <View style={styles.controls}>
      <Pressable
        style={stealthOn ? styles.pillOn : styles.pill}
        onPress={toggle}
        accessibilityRole="switch"
        accessibilityState={a11yState}
        accessibilityLabel="Toggle stealth mode"
      >
        <ThemedShield size={13} uniProps={stealthOn ? okColor : mutedColor} />
        <Text style={stealthOn ? styles.pillTextOn : styles.pillText}>
          {stealthOn ? "Stealth on" : "Stealth off"}
        </Text>
      </Pressable>
      <View style={styles.pill}>
        <ThemedKey size={13} uniProps={mutedColor} />
        <Text style={styles.pillText}>
          {connectedLogins > 0 ? `${connectedLogins} login${connectedLogins === 1 ? "" : "s"}` : "No logins"}
        </Text>
      </View>
    </View>
  );
}

/** Bottom strip: real action count + current step + real anti-detection state. */
export function AntiDetectionStrip({ browserId }: { browserId: string }) {
  const stealthOn = useBrowserStealthStore((s) => s.enabled);
  const steps = useSteps(browserId);
  const actions = useMemo(() => steps.filter((s) => s.command !== "list_tabs").length, [steps]);
  const current = steps.length > 0 ? steps[steps.length - 1] : null;

  return (
    <View style={styles.strip}>
      <ThemedShield size={13} uniProps={stealthOn ? okColor : mutedColor} />
      <Text style={styles.stripLabel}>
        Anti-detection:{" "}
        <Text style={stealthOn ? styles.stripValueOn : styles.stripValueOff}>
          {stealthOn ? "fingerprint randomized · human input" : "off"}
        </Text>
      </Text>
      <View style={styles.stripSep} />
      <Text style={styles.stripMeta}>actions: {actions}</Text>
      {current ? (
        <>
          <ThemedChevron size={12} uniProps={mutedColor} />
          <Text style={styles.stripCurrent} numberOfLines={1}>
            {current.label}
            {current.detail ? ` · ${current.detail}` : ""}
          </Text>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  panel: {
    width: 248,
    borderRightWidth: theme.borderWidth[1],
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  panelHead: {
    padding: theme.spacing[4],
    gap: theme.spacing[1.5],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  panelKicker: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundMuted,
    letterSpacing: 1,
  },
  panelTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  panelStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    marginTop: theme.spacing[1],
  },
  driveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: theme.colors.foregroundMuted },
  driveDotOn: { width: 7, height: 7, borderRadius: 4, backgroundColor: theme.colors.palette.green[500] },
  driveText: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  driveTextOn: { fontSize: theme.fontSize.xs, color: theme.colors.palette.green[500] },
  stepScroll: { flex: 1 },
  stepScrollContent: { padding: theme.spacing[4], gap: 0 },
  stepEmpty: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    lineHeight: 18,
  },
  stepRow: { flexDirection: "row", gap: theme.spacing[2] },
  stepRail: { alignItems: "center", width: 22 },
  stepDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    alignItems: "center",
    justifyContent: "center",
  },
  stepLine: { flex: 1, width: 2, backgroundColor: theme.colors.border, marginVertical: 2 },
  stepBody: { flex: 1, minWidth: 0, paddingBottom: theme.spacing[3] },
  stepLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  stepLabelActive: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.accent,
  },
  stepDetail: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted, marginTop: 1 },
  controls: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1.5] },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  pillOn: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.palette.green[500],
    backgroundColor: theme.colors.surface1,
  },
  pillText: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  pillTextOn: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.palette.green[500],
    fontWeight: theme.fontWeight.medium,
  },
  strip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  stripLabel: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  stripValueOn: { color: theme.colors.palette.green[500], fontWeight: theme.fontWeight.medium },
  stripValueOff: { color: theme.colors.foregroundMuted, fontWeight: theme.fontWeight.medium },
  stripSep: { width: 1, height: 12, backgroundColor: theme.colors.border },
  stripMeta: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted, fontVariant: ["tabular-nums"] },
  stripCurrent: { flex: 1, minWidth: 0, fontSize: theme.fontSize.xs, color: theme.colors.foreground },
}));
