import { memo, useCallback } from "react";
import { Pressable, Text, View } from "react-native";
import type { SshServerInfo, SshSessionInfo } from "@jagentdesk/client/internal/daemon-client";
import type { SshTabStatusState } from "@/ssh/tab-status/tab-status-state";
import { sshTabDotTone } from "@/ssh/tab-status/use-ssh-tab-status";
import { StateDot } from "./primitives";
import { sshStyles as styles } from "./styles";

// Open SSH/Telnet tabs with their status dot (spec 25.4): green unseen output, yellow
// waiting for input, red error or lost connection. Tapping a tab opens it.

const SessionTab = memo(function SessionTab({
  session,
  label,
  status,
  onOpen,
}: {
  session: SshSessionInfo;
  label: string;
  status: SshTabStatusState | undefined;
  onOpen: (terminalId: string) => void;
}) {
  const handlePress = useCallback(() => onOpen(session.terminalId), [onOpen, session.terminalId]);
  return (
    <Pressable
      style={styles.tagChip}
      onPress={handlePress}
      accessibilityLabel={`Open ${label}`}
      testID={`ssh-open-session-${session.terminalId}`}
    >
      <View style={styles.headerRow}>
        <StateDot tone={sshTabDotTone(status)} />
        <Text style={styles.tagText}>{label}</Text>
      </View>
    </Pressable>
  );
});

export function OpenSessionsBar({
  sessions,
  servers,
  statuses,
  onOpen,
}: {
  sessions: SshSessionInfo[];
  servers: SshServerInfo[];
  statuses: Readonly<Record<string, SshTabStatusState>>;
  onOpen: (terminalId: string) => void;
}) {
  if (sessions.length === 0) return null;
  return (
    <View style={styles.tagRow} testID="ssh-open-sessions">
      {sessions.map((session) => (
        <SessionTab
          key={session.terminalId}
          session={session}
          label={
            servers.find((server) => server.id === session.serverId)?.label ?? session.serverId
          }
          status={statuses[session.terminalId]}
          onOpen={onOpen}
        />
      ))}
    </View>
  );
}
