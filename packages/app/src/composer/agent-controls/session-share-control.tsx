import { memo, useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Check, Copy, Plus, Share2, UserX, X } from "lucide-react-native";
import * as Clipboard from "expo-clipboard";
import { AgentControlTrigger } from "@/composer/agent-controls/control";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type {
  SessionShare,
  SessionShareActivity,
  SessionShareMember,
  SessionShareRequest,
} from "@jagentdesk/protocol/messages";

interface PendingItem {
  shareId: string;
  request: SessionShareRequest;
}

/**
 * Host-side "Share session" control (spec §21 / ADR-0018). One agent can have several concurrent
 * shares (separate links/codes), so this manages a LIST: create more, see each link's guests +
 * codes + recent guest messages (who/device sent what), toggle the model/mode grant, and stop
 * individually. A guest join pops an auto Accept/Reject dialog here (daemon-minted code).
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
  const [shares, setShares] = useState<SessionShare[]>([]);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    if (!client || !supported) return;
    let alive = true;
    void (async () => {
      try {
        const list = await client.sessionShareList();
        if (alive) setShares(list.filter((s) => s.agentId === agentId && s.status === "active"));
      } catch {
        // none yet
      }
    })();
    const unsub = client.subscribeSessionShareStream((s) => {
      if (s.agentId !== agentId) return;
      setShares((prev) => upsert(prev, s));
    });
    return () => {
      alive = false;
      unsub();
    };
  }, [client, supported, agentId]);

  const createShare = useCallback(() => {
    if (!client || creating) return;
    setCreating(true);
    setErrorMsg(null);
    void (async () => {
      try {
        const created = await client.sessionShareCreate(agentId);
        setShares((prev) => upsert(prev, created));
      } catch (error) {
        setErrorMsg(error instanceof Error ? error.message : "Couldn't start the shared link.");
      } finally {
        setCreating(false);
      }
    })();
  }, [client, creating, agentId]);

  const onPress = useCallback(() => {
    setSheetOpen(true);
    if (shares.length === 0 && !creating) createShare();
  }, [shares.length, creating, createShare]);

  const onRespond = useCallback(
    (shareId: string, joinRequestId: string, accept: boolean) => {
      if (!client) return;
      void client
        .sessionShareRespond(shareId, joinRequestId, accept)
        .then((next) => setShares((prev) => upsert(prev, next)))
        .catch(() => undefined);
    },
    [client],
  );

  const onStop = useCallback(
    (shareId: string) => {
      if (!client) return;
      void client.sessionShareStop(shareId).catch(() => undefined);
      setShares((prev) => {
        const next = prev.filter((s) => s.shareId !== shareId);
        // Stopping the last link closes the manage sheet — nothing left to manage.
        if (next.length === 0) setSheetOpen(false);
        return next;
      });
    },
    [client],
  );

  const onKick = useCallback(
    (shareId: string, memberId: string) => {
      if (!client) return;
      void client.sessionShareKick(shareId, memberId).catch(() => undefined);
    },
    [client],
  );

  const onToggleModelMode = useCallback(
    (shareId: string, next: boolean) => {
      if (!client) return;
      void client
        .sessionShareSetOptions(shareId, { allowGuestModelMode: next })
        .then((updated) => setShares((prev) => upsert(prev, updated)))
        .catch(() => undefined);
    },
    [client],
  );

  // Grant/revoke a capability live (files / terminal). The daemon re-derives the guest scope from the
  // share's capabilities, so already-connected guests gain/lose the tabs on their next request.
  const onToggleCapability = useCallback(
    (shareId: string, cap: "files" | "terminal" | "readOnly", next: boolean) => {
      if (!client) return;
      void client
        .sessionShareSetOptions(shareId, { capabilities: { [cap]: next } })
        .then((updated) => setShares((prev) => upsert(prev, updated)))
        .catch(() => undefined);
    },
    [client],
  );

  const onCopy = useCallback(
    (shareId: string) => {
      const url = shares.find((s) => s.shareId === shareId)?.tunnelUrl;
      if (!url) return;
      void Clipboard.setStringAsync(url);
      setCopiedId(shareId);
      setTimeout(() => setCopiedId((c) => (c === shareId ? null : c)), 1500);
    },
    [shares],
  );

  const onCloseSheet = useCallback(() => setSheetOpen(false), []);

  if (!supported) return null;

  const active = shares.length > 0;
  const pending: PendingItem[] = shares.flatMap((s) =>
    s.pendingRequests
      .filter((r) => r.status === "pending")
      .map((r) => ({ shareId: s.shareId, request: r })),
  );
  const guestCount = shares.reduce((n, s) => n + s.members.length, 0);

  let tipText: string;
  if (pending.length > 0) {
    tipText = `${pending.length} ${pending.length === 1 ? "person wants" : "people want"} to join — tap to review.`;
  } else if (active) {
    tipText = `Sharing this agent (${shares.length} ${shares.length === 1 ? "link" : "links"}, ${guestCount} ${guestCount === 1 ? "guest" : "guests"}). Tap to manage.`;
  } else {
    tipText = "Share this agent's chat as a web link (a guest can join with your approval).";
  }

  return (
    <>
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild triggerRefProp="ref">
          <AgentControlTrigger
            ref={anchorRef}
            icon={Share2}
            iconColor={active || pending.length > 0 ? styles.iconOn.color : undefined}
            surface="toolbar"
            label="Share session"
            showToolbarLabel={false}
            disabled={!isConnected}
            onPress={onPress}
            accessibilityLabel="Share this agent session"
            testID={`composer-share-toggle-${agentId}`}
          />
        </TooltipTrigger>
        <TooltipContent side="top" align="center" offset={8}>
          <Text style={styles.tipText}>{tipText}</Text>
        </TooltipContent>
      </Tooltip>

      <JoinRequestDialog items={pending} onRespond={onRespond} />
      <ManageSheet
        shares={shares}
        visible={sheetOpen}
        creating={creating}
        errorMsg={errorMsg}
        copiedId={copiedId}
        onClose={onCloseSheet}
        onCreateAnother={createShare}
        onCopy={onCopy}
        onStop={onStop}
        onKick={onKick}
        onRespond={onRespond}
        onToggleModelMode={onToggleModelMode}
        onToggleCapability={onToggleCapability}
      />
    </>
  );
}

function upsert(prev: SessionShare[], s: SessionShare): SessionShare[] {
  const rest = prev.filter((x) => x.shareId !== s.shareId);
  return s.status === "active" ? [...rest, s] : rest;
}

const JoinRequestDialog = memo(function JoinRequestDialog({
  items,
  onRespond,
}: {
  items: PendingItem[];
  onRespond: (shareId: string, joinRequestId: string, accept: boolean) => void;
}): ReactElement {
  return (
    <Modal visible={items.length > 0} transparent animationType="fade" onRequestClose={noop}>
      <View style={styles.backdrop}>
        <View style={styles.dialog}>
          <Text style={styles.dialogTitle}>Someone wants to join</Text>
          {items.map((it) => (
            <PendingRequestRow
              key={it.request.requestId}
              shareId={it.shareId}
              request={it.request}
              onRespond={onRespond}
            />
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
  shareId,
  request,
  onRespond,
}: {
  shareId: string;
  request: SessionShareRequest;
  onRespond: (shareId: string, joinRequestId: string, accept: boolean) => void;
}): ReactElement {
  const onAccept = useCallback(
    () => onRespond(shareId, request.requestId, true),
    [onRespond, shareId, request.requestId],
  );
  const onReject = useCallback(
    () => onRespond(shareId, request.requestId, false),
    [onRespond, shareId, request.requestId],
  );
  return (
    <View style={styles.reqRow}>
      <Text style={styles.reqLabel}>{request.label}</Text>
      {request.device ? <Text style={styles.reqDevice}>{request.device}</Text> : null}
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
  shares,
  visible,
  creating,
  errorMsg,
  copiedId,
  onClose,
  onCreateAnother,
  onCopy,
  onStop,
  onKick,
  onRespond,
  onToggleModelMode,
  onToggleCapability,
}: {
  shares: SessionShare[];
  visible: boolean;
  creating: boolean;
  errorMsg: string | null;
  copiedId: string | null;
  onClose: () => void;
  onCreateAnother: () => void;
  onCopy: (shareId: string) => void;
  onStop: (shareId: string) => void;
  onKick: (shareId: string, memberId: string) => void;
  onRespond: (shareId: string, joinRequestId: string, accept: boolean) => void;
  onToggleModelMode: (shareId: string, next: boolean) => void;
  onToggleCapability: (
    shareId: string,
    cap: "files" | "terminal" | "readOnly",
    next: boolean,
  ) => void;
}): ReactElement {
  const empty = shares.length === 0;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Shared sessions</Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <X size={20} color={styles.icon.color} />
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.sheetBody}>
            {errorMsg ? (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{errorMsg}</Text>
              </View>
            ) : null}
            {empty && creating ? (
              <View style={styles.loadingBox}>
                <ActivityIndicator color={styles.iconOn.color} />
                <Text style={styles.loadingText}>
                  Creating a secure link (starting a Cloudflare tunnel)…
                </Text>
                <Text style={styles.loadingHint}>This can take a few seconds.</Text>
              </View>
            ) : null}
            {shares.map((s, i) => (
              <ShareCard
                key={s.shareId}
                share={s}
                index={i}
                total={shares.length}
                copied={copiedId === s.shareId}
                onCopy={onCopy}
                onStop={onStop}
                onKick={onKick}
                onRespond={onRespond}
                onToggleModelMode={onToggleModelMode}
                onToggleCapability={onToggleCapability}
              />
            ))}
            {!empty ? (
              <Pressable style={styles.newLinkBtn} onPress={onCreateAnother} disabled={creating}>
                <Plus size={16} color={styles.iconOn.color} />
                <Text style={styles.newLinkText}>
                  {creating ? "Creating…" : "Create another link"}
                </Text>
              </Pressable>
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
});

const ShareCard = memo(function ShareCard({
  share,
  index,
  total,
  copied,
  onCopy,
  onStop,
  onKick,
  onRespond,
  onToggleModelMode,
  onToggleCapability,
}: {
  share: SessionShare;
  index: number;
  total: number;
  copied: boolean;
  onCopy: (shareId: string) => void;
  onStop: (shareId: string) => void;
  onKick: (shareId: string, memberId: string) => void;
  onRespond: (shareId: string, joinRequestId: string, accept: boolean) => void;
  onToggleModelMode: (shareId: string, next: boolean) => void;
  onToggleCapability: (
    shareId: string,
    cap: "files" | "terminal" | "readOnly",
    next: boolean,
  ) => void;
}): ReactElement {
  const copyThis = useCallback(() => onCopy(share.shareId), [onCopy, share.shareId]);
  const stopThis = useCallback(() => onStop(share.shareId), [onStop, share.shareId]);
  const kickThis = useCallback(
    (memberId: string) => onKick(share.shareId, memberId),
    [onKick, share.shareId],
  );
  const toggleThis = useCallback(
    (next: boolean) => onToggleModelMode(share.shareId, next),
    [onToggleModelMode, share.shareId],
  );
  const toggleFiles = useCallback(
    (next: boolean) => onToggleCapability(share.shareId, "files", next),
    [onToggleCapability, share.shareId],
  );
  const toggleTerminal = useCallback(
    (next: boolean) => onToggleCapability(share.shareId, "terminal", next),
    [onToggleCapability, share.shareId],
  );
  const toggleReadOnly = useCallback(
    (next: boolean) => onToggleCapability(share.shareId, "readOnly", next),
    [onToggleCapability, share.shareId],
  );

  const pending = share.pendingRequests.filter((r) => r.status === "pending");
  const approved = share.pendingRequests.filter((r) => r.status === "approved");
  const guests = share.members;
  const activity = share.recentActivity ?? [];

  return (
    <View style={styles.card}>
      {total > 1 ? <Text style={styles.cardTitle}>{`Link ${index + 1}`}</Text> : null}
      <Pressable style={styles.urlRow} onPress={copyThis}>
        <Text style={styles.urlText} numberOfLines={1}>
          {share.tunnelUrl ?? "Starting tunnel…"}
        </Text>
        {copied ? (
          <Check size={16} color={styles.iconOn.color} />
        ) : (
          <Copy size={16} color={styles.icon.color} />
        )}
      </Pressable>

      {pending.map((r) => (
        <PendingRequestRow
          key={r.requestId}
          shareId={share.shareId}
          request={r}
          onRespond={onRespond}
        />
      ))}

      <Text style={styles.sectionLabel}>Guest permissions</Text>
      <View style={styles.toggleRow}>
        <Text style={styles.toggleLabel}>Read-only (watch chat, no sending)</Text>
        <Switch
          value={share.capabilities?.readOnly ?? false}
          onValueChange={toggleReadOnly}
          accessibilityLabel="Make the shared chat read-only"
        />
      </View>
      <View style={styles.toggleRow}>
        <Text style={styles.toggleLabel}>View files &amp; diff (read-only)</Text>
        <Switch
          value={share.capabilities?.files ?? false}
          onValueChange={toggleFiles}
          accessibilityLabel="Allow guests to view files and diff"
        />
      </View>
      <View style={styles.toggleRow}>
        <Text style={styles.toggleLabel}>View terminals (read-only)</Text>
        <Switch
          value={share.capabilities?.terminal ?? false}
          onValueChange={toggleTerminal}
          accessibilityLabel="Allow guests to view terminals"
        />
      </View>
      <View style={styles.toggleRow}>
        <Text style={styles.toggleLabel}>Change the agent&apos;s model &amp; mode</Text>
        <Switch
          value={share.allowGuestModelMode}
          onValueChange={toggleThis}
          accessibilityLabel="Allow guests to change model and mode"
        />
      </View>

      {approved.length > 0 ? <Text style={styles.sectionLabel}>Codes to give guests</Text> : null}
      {approved.map((r) => (
        <CodeRow key={r.requestId} request={r} />
      ))}

      <Text style={styles.sectionLabel}>Guests ({guests.length})</Text>
      {guests.length === 0 ? <Text style={styles.muted}>No one has joined yet.</Text> : null}
      {guests.map((g) => (
        <GuestRow key={g.memberId} member={g} onKick={kickThis} />
      ))}

      {activity.length > 0 ? <Text style={styles.sectionLabel}>Recent guest messages</Text> : null}
      {activity.slice(-6).map((a) => (
        <ActivityRow key={`${a.memberId}-${a.at_ms}`} item={a} />
      ))}

      <Pressable style={styles.btnDanger} onPress={stopThis}>
        <Text style={styles.btnPrimaryText}>Stop this link</Text>
      </Pressable>
    </View>
  );
});

const CodeRow = memo(function CodeRow({ request }: { request: SessionShareRequest }): ReactElement {
  const locked = (request.lockedUntil_ms ?? 0) > Date.now();
  const failed = request.failedAttempts ?? 0;
  let note = request.device ?? "";
  if (locked) note = note ? `${note} · locked (too many tries)` : "locked (too many tries)";
  else if (failed > 0) {
    const wrong = `${failed} wrong ${failed === 1 ? "try" : "tries"}`;
    note = note ? `${note} · ${wrong}` : wrong;
  }
  return (
    <View style={styles.codeRow}>
      <View style={styles.guestInfo}>
        <Text style={styles.codeLabel}>{request.label}</Text>
        {note ? (
          <Text style={failed > 0 || locked ? styles.reqDeviceWarn : styles.reqDevice}>{note}</Text>
        ) : null}
      </View>
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
      <View style={styles.guestInfo}>
        <Text style={styles.guestLabel}>
          {member.label}
          {member.typing ? " · typing…" : ""}
        </Text>
        {member.device ? <Text style={styles.reqDevice}>{member.device}</Text> : null}
      </View>
      <Pressable onPress={onPress} hitSlop={8}>
        <UserX size={16} color={styles.danger.color} />
      </Pressable>
    </View>
  );
});

const ActivityRow = memo(function ActivityRow({
  item,
}: {
  item: SessionShareActivity;
}): ReactElement {
  return (
    <View style={styles.activityRow}>
      <Text style={styles.activityWho}>
        {item.label}
        {item.device ? ` · ${item.device}` : ""}
      </Text>
      <Text style={styles.activityText} numberOfLines={3}>
        {item.text}
      </Text>
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
  reqRow: { gap: theme.spacing[1] },
  reqLabel: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  reqDevice: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  reqDeviceWarn: { color: theme.colors.destructive, fontSize: theme.fontSize.xs },
  guestInfo: { flex: 1, gap: 2 },
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
  sheetBody: { padding: theme.spacing[4], gap: theme.spacing[3] },
  card: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  cardTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
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
  loadingBox: { alignItems: "center", gap: theme.spacing[2], paddingVertical: theme.spacing[8] },
  loadingText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
    marginTop: theme.spacing[2],
  },
  loadingHint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  errorBox: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.destructive,
    padding: theme.spacing[3],
  },
  errorText: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
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
  activityRow: { paddingVertical: theme.spacing[1], gap: 1 },
  activityWho: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  activityText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  toggleLabel: { flex: 1, color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  newLinkBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderStyle: "dashed",
  },
  newLinkText: {
    color: theme.colors.accent,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
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
    marginTop: theme.spacing[3],
  },
}));
