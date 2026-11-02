import { useCallback, useMemo, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ArrowLeft, KeyRound, MoreHorizontal, Play, Power } from "lucide-react-native";
import { Alert } from "@/components/ui/alert";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  TerminalPane,
  type TerminalPaneAppearance,
  type TerminalPaneExtraKey,
} from "@/components/terminal-pane";
import { useIsCompactFormFactor } from "@/constants/layout";
import type {
  SshConnectionStateEvent,
  SshGroup,
  SshServerInfo,
  SshServerState,
} from "@jagentdesk/client/internal/daemon-client";
import type { ServerEnvironment } from "@jagentdesk/protocol/ssh/environment-schemas";
import { darkTheme, type Theme } from "@/styles/theme";
import { formatServerTarget } from "@/ssh/group-tree";
import { terminalAppearanceOverride } from "@/ssh/snippets/appearance";
import { sshLiveStatusLabel, type SshServerLiveState } from "@/ssh/use-ssh-connect-events";
import { AuthPromptBar, HostkeyPromptBar, MismatchBanner } from "./prompt-bars";

// An SSH session (spec 25.4, 25.13.1): one header row (status dot, server, user@host:port,
// environment chips, Type password / Disconnect / ⋯), one tab row, then the session body.
// The terminal always uses the dark terminal palette (design system §1.7) at 13px with 12px
// inner padding, unless the server or its group picked a terminal theme.

/** Terminal font size for SSH tabs (design system §2.3). */
export const SSH_TERMINAL_FONT_SIZE = 13;
/** Inner padding of the SSH terminal surface (spacing[3], 25.13.1). */
export const SSH_TERMINAL_PADDING = 12;

export interface ServerSection {
  id: string;
  label: string;
}

export type SshConnectionErrorDetails = NonNullable<SshConnectionStateEvent["error"]>;

export type SessionMenuAction =
  | "redetect"
  | "install-key"
  | "database"
  | "kubernetes"
  | "edit-server";

export interface SessionMenuEntry {
  action: SessionMenuAction;
  label: string;
}

const STATE_LABELS: Record<SshServerState, string> = {
  disconnected: "Disconnected",
  connecting: "Connecting…",
  awaiting_hostkey: "Waiting for host key approval",
  awaiting_auth: "Waiting for credentials",
  connected: "Connected",
  reconnecting: "Connection lost — reconnecting…",
  error: "Connection failed",
};

type DotTone = "connected" | "pending" | "error" | "off";

function dotToneFor(state: SshServerState): DotTone {
  if (state === "connected") return "connected";
  if (state === "error" || state === "reconnecting") return "error";
  if (state === "disconnected") return "off";
  return "pending";
}

function gib(bytes: number | null): string | null {
  return bytes === null ? null : `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** Compact facts for the header chips: OS, arch, CPU, RAM, Docker. */
export function environmentChips(environment: ServerEnvironment | null): string[] {
  if (!environment) return [];
  const os = environment.os;
  const chips = [
    os.prettyName ?? os.distroName ?? os.kernelName,
    os.arch,
    environment.cpuCores === null ? null : `${environment.cpuCores} CPU`,
    gib(environment.memoryTotalBytes),
    environment.docker ? `Docker ${environment.docker.version ?? ""}`.trim() : null,
  ];
  return chips.filter((chip): chip is string => Boolean(chip));
}

const noop = () => {};
const ThemedArrowLeft = withUnistyles(ArrowLeft);
const ThemedKeyRound = withUnistyles(KeyRound);
const ThemedMore = withUnistyles(MoreHorizontal);
const ThemedPower = withUnistyles(Power);
const ThemedPlay = withUnistyles(Play);
const fgTint = (theme: Theme) => ({ color: theme.colors.foreground });
const mutedTint = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function HeaderAction({
  icon: Icon,
  label,
  onPress,
  showLabel,
  testID,
}: {
  icon: typeof ThemedPower;
  label: string;
  onPress: () => void;
  showLabel: boolean;
  testID: string;
}) {
  return (
    <Pressable
      style={showLabel ? styles.action : styles.actionIconOnly}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
    >
      <Icon size={14} uniProps={mutedTint} />
      {showLabel ? <Text style={styles.actionLabel}>{label}</Text> : null}
    </Pressable>
  );
}

function MenuItem({
  entry,
  onSelect,
}: {
  entry: SessionMenuEntry;
  onSelect: (action: SessionMenuAction) => void;
}) {
  const handleSelect = useCallback(() => onSelect(entry.action), [entry.action, onSelect]);
  return (
    <DropdownMenuItem onSelect={handleSelect} testID={`ssh-session-menu-${entry.action}`}>
      {entry.label}
    </DropdownMenuItem>
  );
}

function SessionMenu({
  entries,
  onSelect,
}: {
  entries: readonly SessionMenuEntry[];
  onSelect: (action: SessionMenuAction) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        style={styles.actionIconOnly}
        accessibilityRole="button"
        accessibilityLabel="More actions"
        testID="ssh-session-menu"
      >
        <ThemedMore size={16} uniProps={mutedTint} />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="end" width={240}>
        {entries.map((entry) => (
          <MenuItem key={entry.action} entry={entry} onSelect={onSelect} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const DOT_STYLE: Record<DotTone, "dotConnected" | "dotPending" | "dotError" | "dotOff"> = {
  connected: "dotConnected",
  pending: "dotPending",
  error: "dotError",
  off: "dotOff",
};

function SessionHeader({
  server,
  groups,
  state,
  status,
  chips,
  compact,
  insetsTop,
  menu,
  onBack,
  onDisconnect,
  onReconnect,
  onTypePassword,
  onMenu,
}: {
  server: SshServerInfo;
  groups: SshGroup[];
  state: SshServerState;
  status: string;
  chips: readonly string[];
  compact: boolean;
  insetsTop: number;
  menu: readonly SessionMenuEntry[];
  onBack: () => void;
  onDisconnect: () => void;
  onReconnect: () => void;
  onTypePassword?: () => void;
  onMenu: (action: SessionMenuAction) => void;
}) {
  const canReconnect = state === "error" || state === "disconnected";
  return (
    <View style={[styles.header, { paddingTop: insetsTop + 6 }]} testID="ssh-session-header">
      {compact ? (
        <Pressable
          style={styles.actionIconOnly}
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back to servers"
          testID="ssh-terminal-back"
        >
          <ThemedArrowLeft size={16} uniProps={fgTint} />
        </Pressable>
      ) : null}
      <View
        style={[styles.dot, styles[DOT_STYLE[dotToneFor(state)]]]}
        accessibilityLabel={status}
        testID="ssh-session-dot"
      />
      <Text style={styles.label} numberOfLines={1}>
        {server.label}
      </Text>
      <Text style={styles.target} numberOfLines={1} testID="ssh-terminal-status">
        {compact ? status : `${formatServerTarget(server, groups)} · ${status}`}
      </Text>
      {compact ? null : (
        <View style={styles.chips} testID="ssh-environment-chips">
          {chips.map((chip) => (
            <Text key={chip} style={styles.chip} numberOfLines={1}>
              {chip}
            </Text>
          ))}
        </View>
      )}
      <View style={styles.spacer} />
      {canReconnect ? (
        <HeaderAction
          icon={ThemedPlay}
          label="Reconnect"
          onPress={onReconnect}
          showLabel
          testID="ssh-terminal-reconnect"
        />
      ) : null}
      {onTypePassword && state === "connected" && !compact ? (
        <HeaderAction
          icon={ThemedKeyRound}
          label="Type password"
          onPress={onTypePassword}
          showLabel
          testID="ssh-terminal-password-key"
        />
      ) : null}
      <HeaderAction
        icon={ThemedPower}
        label="Disconnect"
        onPress={onDisconnect}
        showLabel={!compact}
        testID="ssh-terminal-end"
      />
      <SessionMenu entries={menu} onSelect={onMenu} />
    </View>
  );
}

const SELECTED = { selected: true } as const;
const UNSELECTED = { selected: false } as const;

function SectionTab({
  entry,
  active,
  compact,
  onSelect,
}: {
  entry: ServerSection;
  active: boolean;
  compact: boolean;
  onSelect: (id: string) => void;
}) {
  const handlePress = useCallback(() => onSelect(entry.id), [entry.id, onSelect]);
  const desktopStyle = active ? styles.tabActive : styles.tab;
  const compactStyle = active ? styles.segmentActive : styles.segment;
  const style = compact ? compactStyle : desktopStyle;
  return (
    <Pressable
      style={style}
      onPress={handlePress}
      accessibilityRole="tab"
      accessibilityState={active ? SELECTED : UNSELECTED}
      testID={`ssh-section-${entry.id}`}
    >
      <Text style={active ? styles.tabTextActive : styles.tabText}>{entry.label}</Text>
    </Pressable>
  );
}

/** One tab row (25.13.1); a horizontally scrolling segmented control on phones. */
function SectionTabs({
  sections,
  section,
  compact,
  onSectionChange,
}: {
  sections: readonly ServerSection[];
  section: string;
  compact: boolean;
  onSectionChange: (section: string) => void;
}) {
  const tabs = sections.map((entry) => (
    <SectionTab
      key={entry.id}
      entry={entry}
      active={section === entry.id}
      compact={compact}
      onSelect={onSectionChange}
    />
  ));
  if (compact) {
    return (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.segmentBar}
        contentContainerStyle={styles.segmentTrack}
        testID="ssh-session-tabs"
      >
        {tabs}
      </ScrollView>
    );
  }
  return (
    <View style={styles.tabBar} testID="ssh-session-tabs">
      {tabs}
    </View>
  );
}

function FailureNotice({
  error,
  onReplaceHostKey,
}: {
  error: SshConnectionErrorDetails;
  onReplaceHostKey: (error: SshConnectionErrorDetails) => void;
}) {
  const handleReplace = useCallback(() => onReplaceHostKey(error), [error, onReplaceHostKey]);
  if (error.code === "host_key_mismatch" && error.storedFingerprint && error.receivedFingerprint) {
    return (
      <MismatchBanner
        storedFingerprint={error.storedFingerprint}
        receivedFingerprint={error.receivedFingerprint}
        onReplace={handleReplace}
      />
    );
  }
  return (
    <Alert variant="error" title="Connection failed" testID="ssh-connect-error">
      <Text style={styles.noticeText}>{error.message ?? error.code}</Text>
    </Alert>
  );
}

function SessionNotices({
  server,
  live,
  failure,
  actionError,
  onHostkeyDecision,
  onAuthSubmit,
  onReplaceHostKey,
}: {
  server: SshServerInfo;
  live: SshServerLiveState | undefined;
  failure: SshConnectionErrorDetails | undefined;
  actionError: string | null;
  onHostkeyDecision: (serverId: string, decision: "accept" | "reject") => void;
  onAuthSubmit: (serverId: string, answers: string[] | null) => void;
  onReplaceHostKey: (error: SshConnectionErrorDetails) => void;
}) {
  if (!live?.hostkeyPrompt && !live?.authPrompt && !failure && !actionError) return null;
  return (
    <View style={styles.promptStack}>
      {live ? (
        <HostkeyPromptBar serverId={server.id} live={live} onDecision={onHostkeyDecision} />
      ) : null}
      {live ? <AuthPromptBar serverId={server.id} live={live} onSubmit={onAuthSubmit} /> : null}
      {failure ? <FailureNotice error={failure} onReplaceHostKey={onReplaceHostKey} /> : null}
      {actionError ? (
        <Alert variant="error" title={actionError} testID="ssh-terminal-action-error" />
      ) : null}
    </View>
  );
}

export function SshTerminalView({
  hostServerId,
  server,
  groups,
  terminalId,
  live,
  terminalState,
  environment,
  insetsTop,
  sections,
  section,
  onSectionChange,
  sectionContent,
  menu,
  onMenu,
  onBack,
  onEndSession,
  onHostkeyDecision,
  onAuthSubmit,
  onReplaceHostKey,
  onReconnect,
  onTypePassword,
  actionError,
}: {
  hostServerId: string;
  server: SshServerInfo;
  groups: SshGroup[];
  terminalId: string;
  live: SshServerLiveState | undefined;
  terminalState: SshConnectionStateEvent | undefined;
  environment: ServerEnvironment | null;
  insetsTop: number;
  /** Every tab in order, Terminal first (25.13.1). */
  sections: readonly ServerSection[];
  section: string;
  onSectionChange: (section: string) => void;
  /** Body of the selected non-terminal tab. */
  sectionContent: ReactNode;
  menu: readonly SessionMenuEntry[];
  onMenu: (action: SessionMenuAction) => void;
  onBack: () => void;
  onEndSession: () => void;
  onHostkeyDecision: (serverId: string, decision: "accept" | "reject") => void;
  onAuthSubmit: (serverId: string, answers: string[] | null) => void;
  onReplaceHostKey: (error: SshConnectionErrorDetails) => void;
  onReconnect: () => void;
  /** Types the saved password into the tab (25.4 Password key). */
  onTypePassword?: () => void;
  /** Failure of an action taken in this tab (reconnect, password key, replace key). */
  actionError?: string | null;
}) {
  const compact = useIsCompactFormFactor();
  const state = terminalState?.state ?? "connecting";
  const status = sshLiveStatusLabel(live) ?? terminalState?.error?.message ?? STATE_LABELS[state];
  const failure = state === "error" ? terminalState?.error : undefined;
  const chips = useMemo(() => environmentChips(environment), [environment]);
  // Dark terminal palette by default (25.13.1); a server/group theme overrides it (25.4).
  const appearance = useMemo<TerminalPaneAppearance>(() => {
    const override = terminalAppearanceOverride(server, groups);
    return {
      palette: override.palette ?? darkTheme.colors.terminal,
      fontSize: override.fontSize ?? SSH_TERMINAL_FONT_SIZE,
      contentPadding: SSH_TERMINAL_PADDING,
    };
  }, [server, groups]);
  const connected = state === "connected";
  // Spec 25.4: the mobile accessory keyboard gets a Password key; the daemon types the saved
  // password, which never reaches the app.
  const extraKeys = useMemo<TerminalPaneExtraKey[] | undefined>(
    () =>
      onTypePassword && connected
        ? [{ id: "ssh-password", label: "Password", onPress: onTypePassword }]
        : undefined,
    [connected, onTypePassword],
  );
  const terminalFrameStyle = useMemo(
    () => [styles.terminalFrame, { backgroundColor: appearance.palette?.background }],
    [appearance.palette],
  );
  const showTerminal = section === "terminal";
  return (
    <View style={styles.screen} testID="ssh-terminal-view">
      <SessionHeader
        server={server}
        groups={groups}
        state={state}
        status={status}
        chips={chips}
        compact={compact}
        insetsTop={insetsTop}
        menu={menu}
        onBack={onBack}
        onDisconnect={onEndSession}
        onReconnect={onReconnect}
        onTypePassword={onTypePassword}
        onMenu={onMenu}
      />
      <SectionTabs
        sections={sections}
        section={section}
        compact={compact}
        onSectionChange={onSectionChange}
      />
      <SessionNotices
        server={server}
        live={live}
        failure={failure}
        actionError={actionError ?? null}
        onHostkeyDecision={onHostkeyDecision}
        onAuthSubmit={onAuthSubmit}
        onReplaceHostKey={onReplaceHostKey}
      />
      {showTerminal ? null : <View style={styles.sectionBody}>{sectionContent}</View>}
      {/* The terminal stays mounted while another tab is open, so its stream and screen survive. */}
      <View style={showTerminal ? terminalFrameStyle : styles.hidden} testID="ssh-terminal-frame">
        <TerminalPane
          serverId={hostServerId}
          cwd={`ssh:${terminalId}`}
          terminalId={terminalId}
          isWorkspaceFocused
          isPaneFocused={showTerminal}
          onOpenFileExplorer={noop}
          onOpenWorkspaceFile={noop}
          appearance={appearance}
          extraKeys={extraKeys}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  screen: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[1.5],
    minHeight: 44,
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  dot: { width: 8, height: 8, borderRadius: theme.borderRadius.full },
  dotConnected: { backgroundColor: theme.colors.palette.green[500] },
  dotPending: { backgroundColor: theme.colors.palette.amber[500] },
  dotError: { backgroundColor: theme.colors.palette.red[500] },
  dotOff: { backgroundColor: theme.colors.foregroundExtraMuted },
  label: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    flexShrink: 0,
    maxWidth: 220,
  },
  target: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
    minWidth: 0,
  },
  chips: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 1,
    minWidth: 0,
    overflow: "hidden",
  },
  chip: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
  },
  spacer: { flex: 1, minWidth: theme.spacing[2] },
  action: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    height: 28,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  actionIconOnly: {
    alignItems: "center",
    justifyContent: "center",
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
  },
  actionLabel: { fontSize: theme.fontSize.xs, color: theme.colors.foreground },
  tabBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: theme.spacing[4],
    paddingHorizontal: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  tab: {
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabActive: {
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 2,
    borderBottomColor: theme.colors.foreground,
  },
  segmentBar: {
    flexGrow: 0,
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  segmentTrack: {
    flexDirection: "row",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  segment: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface1,
  },
  segmentActive: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
  },
  tabText: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  tabTextActive: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  promptStack: { gap: theme.spacing[2], padding: theme.spacing[3] },
  noticeText: { fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  sectionBody: { flex: 1, minHeight: 0 },
  terminalFrame: { flex: 1, minHeight: 0 },
  hidden: { display: "none" },
}));
