import { memo, useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Check, Copy, Share2, UserX, X } from "lucide-react-native";
import * as Clipboard from "expo-clipboard";
import { AgentControlTrigger } from "@/composer/agent-controls/control";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type {
  SessionShare,
  SessionShareMember,
  SessionShareRequest,
} from "@jagentdesk/protocol/messages";

/**
 * Host-side "Share session" control (spec §21 / ADR-0018) for the composer toolbar. Turns the
 * current agent's chat into a Cloudflare-tunnel web link a guest can open. When a guest asks to
 * join, an Accept/Reject dialog auto-appears here; on Accept the daemon-minted 6-digit code is
 * shown to relay to the guest. Only rendered when the host advertises `sessionSharing`.
 */
export function SessionShareControl({
  agentId,
  serverId,
}: {
  agentId: string;
  serverId: string;
}): ReactElement | null {
  const supported = useHostFeature(serverId, "sessionSharing");
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const anchorRef = useRef<View>(null);
  const [share, setShare] = useState<SessionShare | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!client || !supported) return;
    let alive = true;
    void (async () => {
      try {
        const shares = await client.sessionShareList();
        const mine = shares.find((s) => s.agentId === agentId && s.status === "active");
        if (alive && mine) setShare(mine);
      } catch {
        // No prior share — the button just offers to create one.
      }
    })();
    const unsub = client.subscribeSessionShareStream((s) => {
      if (s.agentId !== agentId) return;
      setShare(s.status === "active" ? s : null);
    });
    return () => {
      alive = false;
      unsub();
    };
  }, [client, supported, agentId]);

  const openOrCreate = useCallback(async () => {
    if (!client || busy) return;
    setBusy(true);
    try {
      if (!share) {
        const created = await client.sessionShareCreate(agentId);
        setShare(created);
      }
      setSheetOpen(true);
    } catch {
      // Errors surface via the shared rpc-error path; keep the button responsive.
    } finally {
      setBusy(false);
    }
  }, [client, busy, share, agentId]);

  const onPress = useCallback(() => {
    void openOrCreate();
  }, [openOrCreate]);

  const onRespond = useCallback(
    (joinRequestId: string, accept: boolean) => {
      if (!client || !share) return;
      void (async () => {
        try {
          const next = await client.sessionShareRespond(share.shareId, joinRequestId, accept);
          setShare(next);
        } catch {
          // ignore — surfaced via rpc-error path
        }
      })();
    },
    [client, share],
  );

  const onStop = useCallback(() => {
    if (!client || !share) return;
    void (async () => {
      try {
        await client.sessionShareStop(share.shareId);
      } catch {
        // ignore
      }
      setShare(null);
      setSheetOpen(false);
    })();
  }, [client, share]);

  const onKick = useCallback(
    (memberId: string) => {
      if (!client || !share) return;
      void (async () => {
        try {
          await client.sessionShareKick(share.shareId, memberId);
        } catch {
          // ignore
        }
      })();
    },
    [client, share],
  );

  const onCopy = useCallback(() => {
    if (!share?.tunnelUrl) return;
    void (async () => {
      await Clipboard.setStringAsync(share.tunnelUrl ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    })();
  }, [share?.tunnelUrl]);

  const onToggleModelMode = useCallback(
    (next: boolean) => {
      if (!client || !share) return;
      void (async () => {
        try {
          const updated = await client.sessionShareSetOptions(share.shareId, {
            allowGuestModelMode: next,
          });
          setShare(updated);
        } catch {
          // ignore — surfaced via rpc-error path
        }
      })();
    },
    [client, share],
  );

  const onCloseSheet = useCallback(() => setSheetOpen(false), []);

  if (!supported) return null;

  const active = share?.status === "active";
  const pending = (share?.pendingRequests ?? []).filter((r) => r.status === "pending");

  return (
    <>
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild triggerRefProp="ref">
          <AgentControlTrigger
            ref={anchorRef}
            icon={Share2}
            iconColor={active ? styles.iconOn.color : undefined}
            surface="toolbar"
            label="Share session"
            showToolbarLabel={false}
            disabled={!isConnected || busy}
            onPress={onPress}
            accessibilityLabel="Share this agent session"
            testID={`composer-share-toggle-${agentId}`}
          />
        </TooltipTrigger>
        <TooltipContent side="top" align="center" offset={8}>
          <Text style={styles.tipText}>
            {active
              ? "Session is shared — tap to manage the link, guests, and code."
              : "Share this agent's chat as a web link (a guest can join with your approval)."}
          </Text>
        </TooltipContent>
      </Tooltip>

      <JoinRequestDialog requests={pending} onRespond={onRespond} />
      <ManageSheet
        share={share}
        visible={sheetOpen}
        copied={copied}
        onClose={onCloseSheet}
        onCopy={onCopy}
        onStop={onStop}
        onKick={onKick}
        onToggleModelMode={onToggleModelMode}
      />
    </>
  );
}

/**
 * Auto Accept/Reject dialog — appears whenever a guest asks to join, even if the manage sheet is
 * closed, and on every host device. The 6-digit code is minted by the daemon so it never
 * conflicts across the host's desktop + mobile.
 */
const JoinRequestDialog = memo(function JoinRequestDialog({
  requests,
  onRespond,
}: {
  requests: SessionShareRequest[];
  onRespond: (joinRequestId: string, accept: boolean) => void;
}): ReactElement {
  return (
    <Modal visible={requests.length > 0} transparent animationType="fade" onRequestClose={noop}>
      <View style={styles.backdrop}>
        <View style={styles.dialog}>
          <Text style={styles.dialogTitle}>Someone wants to join</Text>
          {requests.map((r) => (
            <PendingRequestRow key={r.requestId} request={r} onRespond={onRespond} />
          ))}
          <Text style={styles.dialogHint}>
            Only accept people you trust — they will be able to chat with this agent.
          </Text>
        </View>
      </View>
    </Modal>
  );
});

const PendingRequestRow = memo(function PendingRequestRow({
  request,
  onRespond,
}: {
  request: SessionShareRequest;
  onRespond: (joinRequestId: string, accept: boolean) => void;
}): ReactElement {
  const onAccept = useCallback(
    () => onRespond(request.requestId, true),
    [onRespond, request.requestId],
  );
  const onReject = useCallback(
    () => onRespond(request.requestId, false),
    [onRespond, request.requestId],
  );
  return (
    <View style={styles.reqRow}>
      <Text style={styles.reqLabel}>{request.label}</Text>
      <View style={styles.reqActions}>
        <Pressable style={styles.btnGhost} onPress={onReject}>
          <Text style={styles.btnGhostText}>Reject</Text>
        </Pressable>
        <Pressable style={styles.btnPrimary} onPress={onAccept}>
          <Text style={styles.btnPrimaryText}>Accept</Text>
        </Pressable>
      </View>
    </View>
  );
});

const ManageSheet = memo(function ManageSheet({
  share,
  visible,
  copied,
  onClose,
  onCopy,
  onStop,
  onKick,
  onToggleModelMode,
}: {
  share: SessionShare | null;
  visible: boolean;
  copied: boolean;
  onClose: () => void;
  onCopy: () => void;
  onStop: () => void;
  onKick: (memberId: string) => void;
  onToggleModelMode: (next: boolean) => void;
}): ReactElement {
  const approved = (share?.pendingRequests ?? []).filter((r) => r.status === "approved");
  const guests = share?.members ?? [];
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Shared session</Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <X size={20} color={styles.icon.color} />
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.sheetBody}>
            <Text style={styles.sectionLabel}>Public link</Text>
            <Pressable style={styles.urlRow} onPress={onCopy}>
              <Text style={styles.urlText} numberOfLines={1}>
                {share?.tunnelUrl ?? "Starting tunnel…"}
              </Text>
              {copied ? (
                <Check size={16} color={styles.iconOn.color} />
              ) : (
                <Copy size={16} color={styles.icon.color} />
              )}
            </Pressable>
            <Text style={styles.warn}>
              Anyone with this link + a code you approve can chat with this agent. Dangerous actions
              still ask you for permission here.
            </Text>

            <View style={styles.toggleRow}>
              <Text style={styles.toggleLabel}>Let guests change the agent&apos;s mode</Text>
              <Switch
                value={share?.allowGuestModelMode ?? false}
                onValueChange={onToggleModelMode}
                accessibilityLabel="Allow guests to change model and mode"
              />
            </View>

            {approved.length > 0 ? (
              <Text style={styles.sectionLabel}>Codes to give guests</Text>
            ) : null}
            {approved.map((r) => (
              <CodeRow key={r.requestId} request={r} />
            ))}

            <Text style={styles.sectionLabel}>Guests ({guests.length})</Text>
            {guests.length === 0 ? <Text style={styles.muted}>No one has joined yet.</Text> : null}
            {guests.map((g) => (
              <GuestRow key={g.memberId} member={g} onKick={onKick} />
            ))}

            <Pressable style={styles.btnDanger} onPress={onStop}>
              <Text style={styles.btnPrimaryText}>Stop sharing</Text>
            </Pressable>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
});

const CodeRow = memo(function CodeRow({ request }: { request: SessionShareRequest }): ReactElement {
  return (
    <View style={styles.codeRow}>
      <Text style={styles.codeLabel}>{request.label}</Text>
      <Text style={styles.code}>{request.code ?? "------"}</Text>
    </View>
  );
});

const GuestRow = memo(function GuestRow({
  member,
  onKick,
}: {
  member: SessionShareMember;
  onKick: (memberId: string) => void;
}): ReactElement {
  const onPress = useCallback(() => onKick(member.memberId), [onKick, member.memberId]);
  return (
    <View style={styles.guestRow}>
      <Text style={styles.guestLabel}>
        {member.label}
        {member.typing ? " · typing…" : ""}
      </Text>
      <Pressable onPress={onPress} hitSlop={8}>
        <UserX size={16} color={styles.danger.color} />
      </Pressable>
    </View>
  );
});

function noop(): void {
  // Guest join dialogs are dismissed only by accepting/rejecting, never the OS back gesture.
}

const styles = StyleSheet.create((theme) => ({
  iconOn: { color: theme.colors.accent },
  icon: { color: theme.colors.foregroundMuted },
  danger: { color: theme.colors.destructive },
  tipText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, maxWidth: 260 },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
    padding: theme.spacing[4],
  },
  dialog: {
    width: "100%",
    maxWidth: 380,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.xl,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  dialogTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
  },
  dialogHint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  reqRow: { gap: theme.spacing[2] },
  reqLabel: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  reqActions: { flexDirection: "row", gap: theme.spacing[2], justifyContent: "flex-end" },
  sheet: {
    width: "100%",
    maxWidth: 460,
    maxHeight: "82%",
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.xl,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: theme.spacing[4],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  sheetTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
  },
  sheetBody: { padding: theme.spacing[4], gap: theme.spacing[2] },
  sectionLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: theme.spacing[2],
  },
  urlRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  urlText: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  warn: { color: theme.colors.destructive, fontSize: theme.fontSize.xs },
  codeRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.spacing[2],
  },
  codeLabel: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  code: {
    color: theme.colors.accentBright,
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.bold,
    letterSpacing: 4,
    fontFamily: theme.fontFamily.mono,
  },
  guestRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  guestLabel: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  toggleLabel: { flex: 1, color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  btnPrimary: {
    borderRadius: theme.borderRadius.md,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    alignItems: "center",
    backgroundColor: theme.colors.accent,
  },
  btnPrimaryText: { color: theme.colors.accentForeground, fontWeight: theme.fontWeight.semibold },
  btnGhost: {
    borderRadius: theme.borderRadius.md,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    alignItems: "center",
    backgroundColor: theme.colors.surface3,
  },
  btnGhostText: { color: theme.colors.foreground, fontWeight: theme.fontWeight.medium },
  btnDanger: {
    borderRadius: theme.borderRadius.md,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    alignItems: "center",
    backgroundColor: theme.colors.destructive,
    marginTop: theme.spacing[4],
  },
}));
