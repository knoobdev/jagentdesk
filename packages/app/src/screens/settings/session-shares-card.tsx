import { memo, useCallback, useEffect, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import type { SessionShare } from "@jagentdesk/protocol/messages";

/**
 * Global management of every live shared session (spec §21) — a host can share several agents at
 * once (one share per agent), and this is the one place to see/stop them all, independent of which
 * chat is open. Lists each active share with its guests (name · device) and a Stop control.
 */
export function SessionSharesCard({ serverId }: { serverId: string }): ReactElement | null {
  const supported = useHostFeature(serverId, "sessionSharing");
  const isConnected = useHostRuntimeIsConnected(serverId);
  const client = useHostRuntimeClient(serverId);
  const [shares, setShares] = useState<SessionShare[]>([]);

  useEffect(() => {
    if (!client || !supported) return;
    let alive = true;
    void (async () => {
      try {
        const list = await client.sessionShareList();
        if (alive) setShares(list.filter((s) => s.status === "active"));
      } catch {
        // none yet
      }
    })();
    const unsub = client.subscribeSessionShareStream((s) => {
      setShares((prev) => upsertShare(prev, s));
    });
    return () => {
      alive = false;
      unsub();
    };
  }, [client, supported, serverId]);

  const onStop = useCallback(
    (shareId: string) => {
      if (!client) return;
      void client.sessionShareStop(shareId).catch(() => undefined);
      setShares((prev) => prev.filter((s) => s.shareId !== shareId));
    },
    [client],
  );

  if (!supported || !isConnected) return null;

  return (
    <View style={settingsStyles.card} testID="host-page-session-shares-card">
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>Shared sessions</Text>
        <Text style={settingsStyles.rowHint}>
          {shares.length === 0
            ? "No sessions are being shared right now. Use the Share button in an agent chat to start one."
            : `${shares.length} ${shares.length === 1 ? "session is" : "sessions are"} shared. Anyone with the link + an approved code can chat with that agent.`}
        </Text>
      </View>
      {shares.map((s) => (
        <ShareRow key={s.shareId} share={s} onStop={onStop} />
      ))}
    </View>
  );
}

function upsertShare(prev: SessionShare[], s: SessionShare): SessionShare[] {
  const rest = prev.filter((x) => x.shareId !== s.shareId);
  return s.status === "active" ? [...rest, s] : rest;
}

const ShareRow = memo(function ShareRow({
  share,
  onStop,
}: {
  share: SessionShare;
  onStop: (shareId: string) => void;
}): ReactElement {
  const onPress = useCallback(() => onStop(share.shareId), [onStop, share.shareId]);
  const guests = share.members.filter((m) => m.kind === "guest");
  return (
    <View style={styles.shareRow}>
      <View style={styles.shareInfo}>
        <Text style={styles.shareTitle}>Agent {share.agentId.slice(0, 8)}</Text>
        {guests.length === 0 ? (
          <Text style={styles.shareMeta}>No one has joined yet</Text>
        ) : (
          guests.map((g) => (
            <Text key={g.memberId} style={styles.shareMeta}>
              {g.device ? `${g.label} (${g.device})` : g.label}
              {g.typing ? <Text style={styles.typing}> · typing…</Text> : null}
            </Text>
          ))
        )}
      </View>
      <Pressable style={styles.stopBtn} onPress={onPress}>
        <Text style={styles.stopText}>Stop</Text>
      </Pressable>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  shareRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingTop: theme.spacing[3],
    marginTop: theme.spacing[3],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  shareInfo: { flex: 1, gap: 2 },
  shareTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  shareMeta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  typing: { color: theme.colors.primary, fontWeight: theme.fontWeight.medium },
  stopBtn: {
    borderRadius: theme.borderRadius.md,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    backgroundColor: theme.colors.destructive,
  },
  stopText: {
    color: theme.colors.accentForeground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
}));
