import { useCallback, type ReactNode } from "react";
import { Text, View } from "react-native";
import { Alert } from "@/components/ui/alert";
import { TerminalPane } from "@/components/terminal-pane";
import type {
  SshConnectionStateEvent,
  SshGroup,
  SshServerInfo,
  SshServerState,
} from "@jagentdesk/client/internal/daemon-client";
import { formatServerTarget } from "@/ssh/group-tree";
import {
  sshLiveStatusLabel,
  sshStateTone,
  type SshDotTone,
  type SshServerLiveState,
} from "@/ssh/use-ssh-connect-events";
import { AuthPromptBar, HostkeyPromptBar, MismatchBanner } from "./prompt-bars";
import {
  fgTint,
  IconBtn,
  redTint,
  StateDot,
  TabButton,
  ThemedArrowLeft,
  ThemedKeyRound,
  ThemedPlay,
  ThemedSquare,
} from "./primitives";
import { sshStyles as styles } from "./styles";

// An SSH terminal tab (spec 25.4): the daemon-side session rendered by the shared
// TerminalPane, with the connect prompt bars above it (25.13). The terminal has no
// workspace; `cwd` is only a cache key for the pane.

const SSH_STATE_LABELS: Record<SshServerState, string> = {
  disconnected: "Disconnected",
  connecting: "Connecting…",
  awaiting_hostkey: "Waiting for host key approval",
  awaiting_auth: "Waiting for credentials",
  connected: "Connected",
  reconnecting: "Connection lost — reconnecting…",
  error: "Connection failed",
};

const noop = () => {};

export interface ServerSection {
  id: string;
  label: string;
}

export type SshConnectionErrorDetails = NonNullable<SshConnectionStateEvent["error"]>;

function statusLine(
  live: SshServerLiveState | undefined,
  terminalState: SshConnectionStateEvent | undefined,
): string {
  const state = terminalState?.state ?? "connecting";
  return sshLiveStatusLabel(live) ?? terminalState?.error?.message ?? SSH_STATE_LABELS[state];
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
      <Text style={styles.promptHint}>{error.message ?? error.code}</Text>
    </Alert>
  );
}

function TerminalHeader({
  server,
  groups,
  state,
  status,
  dotTone,
  insetsTop,
  onBack,
  onEndSession,
  onReconnect,
  onTypePassword,
}: {
  server: SshServerInfo;
  groups: SshGroup[];
  state: SshServerState;
  status: string;
  dotTone: SshDotTone;
  insetsTop: number;
  onBack: () => void;
  onEndSession: () => void;
  onReconnect: () => void;
  onTypePassword?: () => void;
}) {
  const canReconnect = state === "error" || state === "disconnected";
  return (
    <View style={[styles.terminalHeader, { paddingTop: insetsTop + 8 }]}>
      <IconBtn
        icon={ThemedArrowLeft}
        tint={fgTint}
        label="Back to servers"
        onPress={onBack}
        testID="ssh-terminal-back"
      />
      <View style={styles.terminalTitle}>
        <View style={styles.headerRow}>
          <StateDot tone={dotTone} />
          <Text style={styles.cellStrong} numberOfLines={1}>
            {server.label}
          </Text>
        </View>
        <Text style={styles.cellSub} numberOfLines={1} testID="ssh-terminal-status">
          {formatServerTarget(server, groups)} · {status}
        </Text>
      </View>
      {canReconnect ? (
        <IconBtn
          icon={ThemedPlay}
          tint={fgTint}
          label="Reconnect"
          onPress={onReconnect}
          testID="ssh-terminal-reconnect"
        />
      ) : null}
      {onTypePassword && state === "connected" ? (
        <IconBtn
          icon={ThemedKeyRound}
          tint={fgTint}
          label="Type saved password"
          onPress={onTypePassword}
          testID="ssh-terminal-password-key"
        />
      ) : null}
      <IconBtn
        icon={ThemedSquare}
        tint={redTint}
        label="Close session"
        onPress={onEndSession}
        testID="ssh-terminal-end"
      />
    </View>
  );
}

function SectionTabs({
  sections,
  section,
  onSectionChange,
}: {
  sections: readonly ServerSection[];
  section: string;
  onSectionChange: (section: string) => void;
}) {
  return (
    <View style={styles.sectionTabs}>
      <TabButton
        label="Terminal"
        value="terminal"
        active={section === "terminal"}
        onSelect={onSectionChange}
        testID="ssh-section-terminal"
      />
      {sections.map((entry) => (
        <TabButton
          key={entry.id}
          label={entry.label}
          value={entry.id}
          active={section === entry.id}
          onSelect={onSectionChange}
          testID={`ssh-section-${entry.id}`}
        />
      ))}
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
  insetsTop,
  sections,
  section = "terminal",
  onSectionChange,
  sectionContent,
  onBack,
  onEndSession,
  onHostkeyDecision,
  onAuthSubmit,
  onReplaceHostKey,
  onReconnect,
  dotTone,
  onTypePassword,
  actionError,
  overview,
}: {
  hostServerId: string;
  server: SshServerInfo;
  groups: SshGroup[];
  terminalId: string;
  live: SshServerLiveState | undefined;
  terminalState: SshConnectionStateEvent | undefined;
  insetsTop: number;
  /** Server sections next to the terminal (SFTP, forwarding, … from milestone modules). */
  sections?: readonly ServerSection[];
  section?: string;
  onSectionChange?: (section: string) => void;
  /** Content of the selected non-terminal section. */
  sectionContent?: ReactNode;
  onBack: () => void;
  onEndSession: () => void;
  onHostkeyDecision: (serverId: string, decision: "accept" | "reject") => void;
  onAuthSubmit: (serverId: string, answers: string[] | null) => void;
  onReplaceHostKey: (error: SshConnectionErrorDetails) => void;
  onReconnect: () => void;
  /** Tab dot from the tab-status machine (25.4); falls back to the connection state. */
  dotTone?: SshDotTone;
  /** Types the saved password into the tab (25.4 Password key). */
  onTypePassword?: () => void;
  /** Failure of an action taken in this tab (reconnect, password key, replace key). */
  actionError?: string | null;
  /** Server overview under the header (environment, Docker, logs, key install; 25.13). */
  overview?: ReactNode;
}) {
  const state = terminalState?.state ?? "connecting";
  const failure = state === "error" ? terminalState?.error : undefined;
  return (
    <View style={styles.terminalScreen} testID="ssh-terminal-view">
      <TerminalHeader
        server={server}
        groups={groups}
        state={state}
        status={statusLine(live, terminalState)}
        dotTone={dotTone ?? sshStateTone(state)}
        insetsTop={insetsTop}
        onBack={onBack}
        onEndSession={onEndSession}
        onReconnect={onReconnect}
        onTypePassword={onTypePassword}
      />
      {overview ?? null}
      {sections && sections.length > 0 && onSectionChange ? (
        <SectionTabs sections={sections} section={section} onSectionChange={onSectionChange} />
      ) : null}
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
      {section === "terminal" ? null : sectionContent}
      <View style={section === "terminal" ? styles.terminalBody : styles.hidden}>
        <TerminalPane
          serverId={hostServerId}
          cwd={`ssh:${terminalId}`}
          terminalId={terminalId}
          isWorkspaceFocused
          isPaneFocused
          onOpenFileExplorer={noop}
          onOpenWorkspaceFile={noop}
        />
      </View>
    </View>
  );
}
