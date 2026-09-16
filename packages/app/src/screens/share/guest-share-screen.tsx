import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AgentConversationPanel } from "@/panels/agent-panel";
import {
  PaneFocusProvider,
  PaneProvider,
  createPaneFocusContextValue,
  type PaneContextValue,
} from "@/panels/pane-context";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { applyLegacyDaemonWorkspaceOwnership } from "@/workspace/legacy-daemon-workspaces";

/**
 * Guest session screen (spec §21 / ADR-0019). Served as the REAL app through the Cloudflare tunnel;
 * the guest pairs with a 6-digit code (bespoke /guest channel), then we register a guest host
 * runtime pointed at the scoped /ws with the guest token and render the actual agent chat
 * (`AgentConversationPanel` + real composer). No editor/workspace chrome — just the shared agent.
 */
export interface GuestShareHint {
  agentId: string;
  agentLabel: string;
}

export function readGuestShareHint(): GuestShareHint | null {
  const g = (globalThis as { __JAGENTDESK_SHARE__?: { agentId?: unknown; agentLabel?: unknown } })
    .__JAGENTDESK_SHARE__;
  if (g && typeof g.agentId === "string" && g.agentId) {
    return {
      agentId: g.agentId,
      agentLabel: typeof g.agentLabel === "string" ? g.agentLabel : "Agent",
    };
  }
  if (typeof location !== "undefined") {
    try {
      const p = new URLSearchParams(location.search);
      const a = p.get("agentId");
      if (a) return { agentId: a, agentLabel: p.get("agentLabel") ?? "Agent" };
    } catch {
      // ignore
    }
  }
  return null;
}

type Phase =
  | { k: "request" }
  | { k: "pending" }
  | { k: "gate" }
  | { k: "connecting" }
  | { k: "ready"; serverId: string; workspaceId: string }
  | { k: "ended"; reason: string };

export function GuestShareScreen({ hint }: { hint: GuestShareHint }): ReactElement {
  const wsRef = useRef<WebSocket | null>(null);
  const [phase, setPhase] = useState<Phase>({ k: "request" });
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const pairingRef = useRef(false);

  const goReady = useCallback(
    async (guestToken: string) => {
      setPhase({ k: "connecting" });
      try {
        const store = getHostRuntimeStore();
        const useTls = typeof location !== "undefined" && location.protocol === "https:";
        const endpoint = typeof location !== "undefined" ? location.host : "127.0.0.1";
        const { serverId } = await store.probeAndUpsertDirectConnection({
          endpoint,
          useTls,
          password: guestToken,
          label: hint.agentLabel,
        });
        // The guest scope forbids the host's fetch_agents/project.list directory bootstraps, so the
        // session store won't auto-populate. Fetch the ONE shared agent (agentId-guarded) and place
        // it in the store ourselves so the real AgentConversationPanel renders it.
        const client = store.getSnapshot(serverId)?.client ?? null;
        let workspaceId = "";
        try {
          const res = await client?.fetchAgent({ agentId: hint.agentId });
          if (res?.agent) {
            workspaceId = res.agent.workspaceId ?? "";
            const normalized = applyLegacyDaemonWorkspaceOwnership({
              serverId,
              agent: normalizeAgentSnapshot(res.agent, serverId),
            });
            useSessionStore.getState().setAgents(serverId, (prev) => {
              const next = new Map(prev);
              next.set(hint.agentId, normalized);
              return next;
            });
          }
        } catch {
          // proceed without it
        }
        setPhase({ k: "ready", serverId, workspaceId });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't connect to the shared session.");
        setPhase({ k: "request" });
      }
    },
    [hint.agentId, hint.agentLabel],
  );

  const connectPairing = useCallback(() => {
    const proto =
      typeof location !== "undefined" && location.protocol === "https:" ? "wss:" : "ws:";
    const host = typeof location !== "undefined" ? location.host : "127.0.0.1";
    const ws = new WebSocket(`${proto}//${host}/guest`);
    wsRef.current = ws;
    ws.addEventListener("message", (ev) => {
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(String((ev as MessageEvent).data));
      } catch {
        return;
      }
      if (m.t === "pending") setPhase({ k: "pending" });
      else if (m.t === "approved") {
        setPhase({ k: "gate" });
        setError(null);
      } else if (m.t === "rejected")
        setPhase({ k: "ended", reason: "The host declined the request." });
      else if (m.t === "pair_result") {
        pairingRef.current = false;
        if (m.ok && typeof m.guestToken === "string") {
          void goReady(m.guestToken);
        } else {
          setError((m.error as string) ?? "Incorrect code.");
          setCode("");
        }
      } else if (m.t === "ended")
        setPhase({ k: "ended", reason: (m.reason as string) ?? "Session ended." });
    });
    ws.addEventListener("close", () => {
      setPhase((p) =>
        p.k === "ready" || p.k === "ended" ? p : { k: "ended", reason: "Disconnected." },
      );
    });
    return ws;
  }, [goReady]);

  const onRequest = useCallback(() => {
    setError(null);
    const ws = wsRef.current && wsRef.current.readyState === 1 ? wsRef.current : connectPairing();
    const payload = JSON.stringify({ t: "request", name: name.trim().slice(0, 40) });
    if (ws.readyState === 1) ws.send(payload);
    else ws.addEventListener("open", () => ws.send(payload), { once: true });
    setPhase({ k: "pending" });
  }, [connectPairing, name]);

  const onCodeChange = useCallback((next: string) => {
    const digits = next.replace(/\D/g, "").slice(0, 6);
    setCode(digits);
    setError(null);
    if (digits.length === 6 && !pairingRef.current && wsRef.current?.readyState === 1) {
      pairingRef.current = true;
      wsRef.current.send(JSON.stringify({ t: "pair", code: digits }));
    }
  }, []);

  useEffect(() => {
    return () => {
      try {
        wsRef.current?.close();
      } catch {
        // ignore
      }
    };
  }, []);

  const paneValue = useMemo<PaneContextValue | null>(() => {
    if (phase.k !== "ready") return null;
    return {
      serverId: phase.serverId,
      workspaceId: phase.workspaceId,
      tabId: "guest",
      target: { kind: "agent", agentId: hint.agentId },
      openTab: () => {},
      closeCurrentTab: () => {},
      retargetCurrentTab: () => {},
      openFileInWorkspace: () => {},
      openImportSheet: () => {},
    };
  }, [phase, hint.agentId]);

  if (phase.k === "ready" && paneValue) {
    return (
      <PaneProvider value={paneValue}>
        <PaneFocusProvider
          value={createPaneFocusContextValue({ isWorkspaceFocused: true, isPaneFocused: true })}
        >
          <View style={styles.chatRoot}>
            <AgentConversationPanel />
          </View>
        </PaneFocusProvider>
      </PaneProvider>
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.card}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{(hint.agentLabel[0] ?? "A").toUpperCase()}</Text>
        </View>
        <GuestGate
          phase={phase}
          agentLabel={hint.agentLabel}
          name={name}
          code={code}
          error={error}
          onName={setName}
          onRequest={onRequest}
          onCode={onCodeChange}
        />
      </View>
    </View>
  );
}

function GuestGate({
  phase,
  agentLabel,
  name,
  code,
  error,
  onName,
  onRequest,
  onCode,
}: {
  phase: Phase;
  agentLabel: string;
  name: string;
  code: string;
  error: string | null;
  onName: (v: string) => void;
  onRequest: () => void;
  onCode: (v: string) => void;
}): ReactElement {
  if (phase.k === "ended") {
    return (
      <>
        <Text style={styles.title}>Session ended</Text>
        <Text style={styles.sub}>{phase.reason}</Text>
      </>
    );
  }
  if (phase.k === "pending") {
    return (
      <>
        <ActivityIndicator color={styles.accentText.color} />
        <Text style={styles.title}>Waiting for the host…</Text>
        <Text style={styles.sub}>
          The host is deciding whether to let you in. Keep this tab open.
        </Text>
      </>
    );
  }
  if (phase.k === "connecting") {
    return (
      <>
        <ActivityIndicator color={styles.accentText.color} />
        <Text style={styles.title}>Connecting…</Text>
      </>
    );
  }
  if (phase.k === "gate") {
    return (
      <>
        <Text style={styles.title}>Enter the 6-digit code</Text>
        <Text style={styles.sub}>
          Ask the host for the code showing in their app — it verifies automatically.
        </Text>
        <TextInput
          style={styles.codeInput}
          value={code}
          onChangeText={onCode}
          keyboardType="number-pad"
          maxLength={6}
          placeholder="••••••"
          placeholderTextColor={styles.mutedText.color}
          autoFocus
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </>
    );
  }
  return (
    <>
      <Text style={styles.title}>Join this session</Text>
      <Text style={styles.sub}>
        Chat with {agentLabel}. Enter your name so the host knows who is asking to join.
      </Text>
      <TextInput
        style={styles.input}
        value={name}
        onChangeText={onName}
        placeholder="Your name"
        placeholderTextColor={styles.mutedText.color}
        maxLength={40}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable style={styles.btn} onPress={onRequest}>
        <Text style={styles.btnText}>Request to join</Text>
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  chatRoot: { flex: 1, backgroundColor: theme.colors.surface0 },
  card: {
    width: "100%",
    maxWidth: 380,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.xl,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    padding: theme.spacing[6],
    gap: theme.spacing[3],
    alignItems: "center",
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    color: theme.colors.accentForeground,
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.bold,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
    textAlign: "center",
  },
  sub: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, textAlign: "center" },
  input: {
    width: "100%",
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  codeInput: {
    width: "100%",
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    color: theme.colors.foreground,
    fontSize: theme.fontSize["3xl"],
    letterSpacing: 8,
    textAlign: "center",
    fontFamily: theme.fontFamily.mono,
  },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm, textAlign: "center" },
  btn: {
    width: "100%",
    backgroundColor: theme.colors.accent,
    borderRadius: theme.borderRadius.md,
    paddingVertical: theme.spacing[3],
    alignItems: "center",
  },
  btnText: {
    color: theme.colors.accentForeground,
    fontWeight: theme.fontWeight.semibold,
    fontSize: theme.fontSize.base,
  },
  accentText: { color: theme.colors.accent },
  mutedText: { color: theme.colors.foregroundMuted },
}));
