import { useCallback, useReducer, useRef, useState, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ListChecks } from "lucide-react-native";
import { router } from "expo-router";
import {
  SPEC_MODE_OPTIONAL_PHASES,
  specModePhaseLabel,
  type SpecModeOptionalPhase,
  type SpecModeState,
} from "@jagentdesk/protocol/spec-mode";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "@/components/ui/external-link";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AgentControlTrigger } from "@/composer/agent-controls/control";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useAutorunState, useSpecModeState } from "@/spec-mode/use-spec-mode";
import { useSessionStore } from "@/stores/session-store";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";

const SPEC_KIT_LICENSE_URL = "https://github.com/github/spec-kit/blob/main/LICENSE";
const NO_OPTIONS: ComboboxOption[] = [];
const NO_PHASES: SpecModeOptionalPhase[] = [];

/** What the popover is doing (spec 28.3 step 4: list files, write only on Set up). */
type Stage =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "confirm"; files: string[]; optionalPhases: SpecModeOptionalPhase[] }
  | { kind: "error"; message: string };

type StageAction =
  | { type: "pending" }
  | { type: "confirm"; files: string[]; optionalPhases: SpecModeOptionalPhase[] }
  | { type: "fail"; message: string }
  | { type: "reset" };

function stageReducer(_stage: Stage, action: StageAction): Stage {
  switch (action.type) {
    case "pending":
      return { kind: "pending" };
    case "confirm":
      return { kind: "confirm", files: action.files, optionalPhases: action.optionalPhases };
    case "fail":
      return { kind: "error", message: action.message };
    case "reset":
      return { kind: "idle" };
  }
}

const OPTIONAL_PHASE_HINTS: Record<SpecModeOptionalPhase, string> = {
  clarify: "Ask up to 5 questions about the spec before planning",
  checklist: "Write a requirements quality checklist after the plan",
  analyze: "Check spec, plan and tasks for consistency before implementing",
};

function triggerValue(state: SpecModeState | null): string {
  if (!state?.enabled) return "Spec mode";
  if (state.converged) return "Converged";
  return state.phase ? specModePhaseLabel(state.phase) : "Spec mode";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface BlockReason {
  text: string;
  canInstall: boolean;
}

function useBlockReason(
  serverId: string,
  agentId: string,
  state: SpecModeState | null,
): BlockReason | null {
  const autorun = useAutorunState(serverId, agentId);
  const specKit = useSessionStore(
    (store) => store.sessions[serverId]?.serverInfo?.capabilities?.host?.specKit ?? null,
  );
  if (state?.enabled) return null;
  if (autorun.state?.status === "running") {
    return { text: "Turn off autonomous mode to use Spec mode", canInstall: false };
  }
  if (specKit && specKit.state !== "available") {
    return { text: specKit.reason, canInstall: specKit.installable.length > 0 };
  }
  return null;
}

/**
 * Spec mode toggle in the composer (spec 28): when on, the agent follows GitHub Spec Kit one
 * phase at a time and the user approves each phase. The popover holds the switch, the
 * optional phases (remembered per workspace by the daemon), the first-time setup file list
 * and the Spec Kit attribution. Shown only when the host advertises `specMode`.
 */
export function SpecModeControl({
  agentId,
  serverId,
}: {
  agentId: string;
  serverId: string;
}): ReactElement | null {
  const isCompact = useIsCompactFormFactor();
  const { supported, state, client, isConnected } = useSpecModeState(serverId, agentId);
  const blocked = useBlockReason(serverId, agentId, state);
  const anchorRef = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const [stage, dispatch] = useReducer(stageReducer, { kind: "idle" });
  const enabled = state?.enabled === true;
  const optionalPhases = state?.optionalPhases ?? NO_PHASES;

  const applySet = useCallback(
    async (params: {
      enabled: boolean;
      optionalPhases?: SpecModeOptionalPhase[];
      confirmSetup?: boolean;
    }) => {
      if (!client) return;
      dispatch({ type: "pending" });
      try {
        const result = await client.specModeSet({ agentId, ...params });
        if (result.error) dispatch({ type: "fail", message: result.error.message });
        else dispatch({ type: "reset" });
      } catch (error) {
        dispatch({ type: "fail", message: errorMessage(error) });
      }
    },
    [agentId, client],
  );

  const turnOn = useCallback(
    async (phases: SpecModeOptionalPhase[]) => {
      if (!client) return;
      dispatch({ type: "pending" });
      try {
        const preview = await client.specModeSetupPreview(agentId);
        if (preview.error) {
          dispatch({ type: "fail", message: preview.error.message });
          return;
        }
        if (preview.missingTools.length > 0) {
          dispatch({ type: "fail", message: preview.missingTools.join("; ") });
          return;
        }
        if (preview.files.length > 0) {
          dispatch({ type: "confirm", files: preview.files, optionalPhases: phases });
          return;
        }
        await applySet({ enabled: true, optionalPhases: phases });
      } catch (error) {
        dispatch({ type: "fail", message: errorMessage(error) });
      }
    },
    [agentId, applySet, client],
  );

  const handleSwitch = useCallback(
    (next: boolean) => {
      if (next) void turnOn(optionalPhases);
      else void applySet({ enabled: false });
    },
    [applySet, optionalPhases, turnOn],
  );

  const handleTogglePhase = useCallback(
    (phase: SpecModeOptionalPhase, on: boolean) => {
      const next = on
        ? [...optionalPhases.filter((value) => value !== phase), phase]
        : optionalPhases.filter((value) => value !== phase);
      if (enabled) void applySet({ enabled: true, optionalPhases: next });
      else void turnOn(next);
    },
    [applySet, enabled, optionalPhases, turnOn],
  );

  const handleConfirm = useCallback(() => {
    if (stage.kind !== "confirm") return;
    void applySet({ enabled: true, optionalPhases: stage.optionalPhases, confirmSetup: true });
  }, [applySet, stage]);
  const handleCancel = useCallback(() => dispatch({ type: "reset" }), []);
  const handleInstall = useCallback(() => {
    setOpen(false);
    router.push(buildSettingsHostSectionRoute(serverId, "tools"));
  }, [serverId]);
  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) dispatch({ type: "reset" });
  }, []);
  const handlePress = useCallback(() => setOpen((previous) => !previous), []);

  if (!supported) return null;

  const isPending = stage.kind === "pending";
  const switchDisabled = !isConnected || isPending || blocked !== null;
  const value = triggerValue(state);
  const tooltip =
    blocked?.text ??
    (enabled
      ? `Spec mode is on · ${value}`
      : "Spec mode: build with GitHub Spec Kit, one approved phase at a time");

  return (
    <>
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild triggerRefProp="ref">
          <AgentControlTrigger
            ref={anchorRef}
            icon={ListChecks}
            iconColor={enabled ? styles.iconOn.color : undefined}
            surface="toolbar"
            label="Spec mode"
            value={value}
            showToolbarLabel={enabled && !isCompact}
            showCaret={false}
            open={open}
            disabled={!isConnected}
            onPress={handlePress}
            accessibilityLabel={enabled ? `Spec mode on, ${value}` : "Spec mode"}
            testID={`composer-spec-mode-${agentId}`}
          />
        </TooltipTrigger>
        <TooltipContent side="top" align="center" offset={8}>
          <View style={styles.tooltip}>
            <Text style={styles.tooltipText}>{tooltip}</Text>
          </View>
        </TooltipContent>
      </Tooltip>
      <Combobox
        options={NO_OPTIONS}
        value=""
        onSelect={noop}
        open={open}
        onOpenChange={handleOpenChange}
        anchorRef={anchorRef}
        desktopPlacement="top-start"
        desktopMinWidth={320}
        title="Spec mode"
      >
        <View style={styles.panel} testID="spec-mode-popover">
          <View style={styles.row}>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>Spec mode</Text>
              <Text style={styles.rowHint}>
                Specify, plan, tasks, implement — you approve each phase.
              </Text>
            </View>
            <Switch
              value={enabled}
              onValueChange={handleSwitch}
              disabled={switchDisabled}
              accessibilityLabel="Spec mode"
              testID="spec-mode-switch"
            />
          </View>
          {blocked ? (
            <View style={styles.blocked} testID="spec-mode-blocked">
              <Text style={styles.blockedText}>{blocked.text}</Text>
              {blocked.canInstall ? (
                <Button
                  size="sm"
                  variant="outline"
                  onPress={handleInstall}
                  testID="spec-mode-install"
                >
                  Install
                </Button>
              ) : null}
            </View>
          ) : null}
          {stage.kind === "confirm" ? (
            <SetupConfirmation
              files={stage.files}
              onConfirm={handleConfirm}
              onCancel={handleCancel}
            />
          ) : null}
          {stage.kind === "error" ? (
            <Alert variant="error" title="Spec mode" description={stage.message} />
          ) : null}
          <Text style={styles.sectionTitle}>Optional phases</Text>
          {SPEC_MODE_OPTIONAL_PHASES.map((phase) => (
            <OptionalPhaseRow
              key={phase}
              phase={phase}
              on={optionalPhases.includes(phase)}
              disabled={switchDisabled}
              onToggle={handleTogglePhase}
            />
          ))}
          <ExternalLink
            href={SPEC_KIT_LICENSE_URL}
            label="Based on GitHub Spec Kit (MIT)"
            testID="spec-mode-attribution"
          />
        </View>
      </Combobox>
    </>
  );
}

function noop(): void {}

function SetupConfirmation({
  files,
  onConfirm,
  onCancel,
}: {
  files: string[];
  onConfirm: () => void;
  onCancel: () => void;
}): ReactElement {
  return (
    <View style={styles.confirm} testID="spec-mode-setup">
      <Text style={styles.rowTitle}>Set up Spec mode in this workspace</Text>
      <Text style={styles.rowHint}>{files.length} files will be created:</Text>
      <ScrollView style={styles.fileList}>
        {files.map((file) => (
          <Text key={file} style={styles.fileText} numberOfLines={1}>
            {file}
          </Text>
        ))}
      </ScrollView>
      <View style={styles.actions}>
        <Button size="sm" variant="default" onPress={onConfirm} testID="spec-mode-setup-confirm">
          Set up
        </Button>
        <Button size="sm" variant="outline" onPress={onCancel} testID="spec-mode-setup-cancel">
          Cancel
        </Button>
      </View>
    </View>
  );
}

function OptionalPhaseRow({
  phase,
  on,
  disabled,
  onToggle,
}: {
  phase: SpecModeOptionalPhase;
  on: boolean;
  disabled: boolean;
  onToggle: (phase: SpecModeOptionalPhase, on: boolean) => void;
}): ReactElement {
  const handleChange = useCallback((next: boolean) => onToggle(phase, next), [onToggle, phase]);
  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{specModePhaseLabel(phase)}</Text>
        <Text style={styles.rowHint}>{OPTIONAL_PHASE_HINTS[phase]}</Text>
      </View>
      <Switch
        value={on}
        onValueChange={handleChange}
        disabled={disabled}
        accessibilityLabel={`${specModePhaseLabel(phase)} phase`}
        testID={`spec-mode-phase-${phase}`}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  iconOn: { color: theme.colors.accent },
  tooltip: { maxWidth: 260 },
  tooltipText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  panel: {
    padding: theme.spacing[3],
    gap: theme.spacing[3],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  rowText: {
    flex: 1,
    gap: theme.spacing[1],
  },
  rowTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  rowHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  sectionTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    marginTop: theme.spacing[1],
  },
  blocked: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  blockedText: {
    flex: 1,
    color: theme.colors.palette.amber[500],
    fontSize: theme.fontSize.sm,
  },
  confirm: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  fileList: {
    maxHeight: 160,
  },
  fileText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
}));
