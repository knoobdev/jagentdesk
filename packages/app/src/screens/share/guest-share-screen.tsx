import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AgentConversationPanel } from "@/panels/agent-panel";
import { filePanelRegistration } from "@/panels/file-panel";
import { workingDiffPanelRegistration } from "@/panels/diff-panel";
import { terminalPanelRegistration } from "@/panels/terminal-panel";
import { FileExplorerPane } from "@/components/file-explorer-pane";
import { useFetchQuery } from "@/data/query";
import { buildTerminalsQueryKey } from "@/screens/workspace/terminals/state";
import {
  PaneFocusProvider,
  PaneProvider,
  createPaneFocusContextValue,
  type PaneContextValue,
} from "@/panels/pane-context";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { applyLegacyDaemonWorkspaceOwnership } from "@/workspace/legacy-daemon-workspaces";

const WorkingDiffPanel = workingDiffPanelRegistration.component;
const FilePanel = filePanelRegistration.component;
const TerminalPanel = terminalPanelRegistration.component;

// Seed a minimal workspace descriptor so useWorkspaceDirectory(serverId, workspaceId) resolves to
// the shared agent's cwd — required by the file + working-diff panels (they read the directory from
// the store). Keyed by workspaceId so the pane's workspaceId lookup finds it.
function seedGuestWorkspace(serverId: string, workspaceId: string, cwd: string): void {
  const descriptor: WorkspaceDescriptor = {
    id: workspaceId,
    projectId: "guest",
    projectDisplayName: "Shared workspace",
    projectRootPath: cwd,
    workspaceDirectory: cwd,
    projectKind: "directory",
    workspaceKind: "directory",
    name: "Shared workspace",
    status: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
  };
  useSessionStore.getState().mergeWorkspaces(serverId, [descriptor]);
}

/**
 * Guest session screen (spec §21 / ADR-0019). Served as the REAL app through the Cloudflare tunnel;
 * the guest pairs with a 6-digit code (bespoke /guest channel), then we register a guest host
 * runtime pointed at the scoped /ws with the guest token and render the actual agent chat
 * (`AgentConversationPanel` + real composer). No editor/workspace chrome — just the shared agent.
 */
export interface GuestShareCapabilities {
  chat: boolean;
  files: boolean;
  terminal: boolean;
  modelMode: boolean;
}

export interface GuestShareHint {
  agentId: string;
  agentLabel: string;
  capabilities: GuestShareCapabilities;
  workspaceCwd: string;
}

// chat is always on; everything else defaults OFF (host must grant). Read from the injected hint.
function readCapabilities(raw: unknown): GuestShareCapabilities {
  const c = (raw ?? {}) as Partial<Record<keyof GuestShareCapabilities, unknown>>;
  return {
    chat: true,
    files: c.files === true,
    terminal: c.terminal === true,
    modelMode: c.modelMode === true,
  };
}

export function readGuestShareHint(): GuestShareHint | null {
  const g = (
    globalThis as {
      __JAGENTDESK_SHARE__?: {
        agentId?: unknown;
        agentLabel?: unknown;
        capabilities?: unknown;
        workspaceCwd?: unknown;
      };
    }
  ).__JAGENTDESK_SHARE__;
  if (g && typeof g.agentId === "string" && g.agentId) {
    return {
      agentId: g.agentId,
      agentLabel: typeof g.agentLabel === "string" ? g.agentLabel : "Agent",
      capabilities: readCapabilities(g.capabilities),
      workspaceCwd: typeof g.workspaceCwd === "string" ? g.workspaceCwd : "",
    };
  }
  if (typeof location !== "undefined") {
    try {
      const p = new URLSearchParams(location.search);
      const a = p.get("agentId");
      if (a)
        return {
          agentId: a,
          agentLabel: p.get("agentLabel") ?? "Agent",
          capabilities: readCapabilities(null),
          workspaceCwd: p.get("workspaceCwd") ?? "",
        };
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
  | { k: "ready"; serverId: string; workspaceId: string; workspaceCwd: string }
  | { k: "ended"; reason: string };

export function GuestShareScreen({ hint }: { hint: GuestShareHint }): ReactElement {
  const wsRef = useRef<WebSocket | null>(null);
  const [phase, setPhase] = useState<Phase>({ k: "request" });
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const pairingRef = useRef(false);
  const phaseRef = useRef<Phase>({ k: "request" });
  const nameRef = useRef("");
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const goReady = useCallback(
    async (guestToken: string) => {
      // Pairing succeeded — cancel any pending pairing-reconnect so it can't fire after we're ready.
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectAttemptsRef.current = 0;
      setPhase({ k: "connecting" });
      try {
        const store = getHostRuntimeStore();
        const useTls = typeof location !== "undefined" && location.protocol === "https:";
        // probeAndUpsertDirectConnection parses `endpoint` as host:PORT (port mandatory). A tunnel
        // URL (https://<name>.trycloudflare.com) has no explicit port, so append the scheme default
        // — otherwise pairing fails with "Invalid host:port". Loopback shares already carry a port.
        const rawHost = typeof location !== "undefined" ? location.host : "127.0.0.1:6767";
        const endpoint = /:\d+$/.test(rawHost) ? rawHost : `${rawHost}:${useTls ? 443 : 80}`;
        const { serverId } = await store.probeAndUpsertDirectConnection({
          endpoint,
          useTls,
          password: guestToken,
          label: hint.agentLabel,
        });
        // The guest's fetch_agents/project.list are answered but FILTERED server-side to the one
        // shared agent / empty projects, so the store may not carry the workspaceId we need. Fetch
        // the ONE shared agent (agentId-guarded) and place it in the store ourselves so the real
        // AgentConversationPanel renders it with the right workspace binding.
        // The workspace directory comes straight from the daemon-injected share hint (no dependency
        // on a fetch_agent round-trip). Use it as the unified workspace key for the guest surface so
        // the Files/Changes panels resolve the directory; the actual store seed happens reactively in
        // GuestReadyView once the session entry exists.
        const workspaceCwd = hint.workspaceCwd;
        const workspaceId = workspaceCwd;
        // Best-effort: place the shared agent snapshot in the store so the chat panel has it early.
        const client = store.getSnapshot(serverId)?.client ?? null;
        try {
          const res = await client?.fetchAgent({ agentId: hint.agentId });
          if (res?.agent) {
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
        setPhase({ k: "ready", serverId, workspaceId, workspaceCwd });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't connect to the shared session.");
        setPhase({ k: "request" });
      }
    },
    [hint.agentId, hint.agentLabel, hint.workspaceCwd],
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
      // A drop DURING the handshake (e.g. phone screen turned off while "Requesting to join") used
      // to dead-end at "Disconnected". Auto-reconnect + re-send the request a few times so the guest
      // recovers on wake. After ready, the scoped /ws (DaemonClient) owns the connection and the
      // pairing channel is disposable, so leave that phase alone.
      const cur = phaseRef.current.k;
      if (cur === "ready" || cur === "ended") return;
      if (reconnectAttemptsRef.current >= 8) {
        setPhase({ k: "ended", reason: "Disconnected. Reload the page to try again." });
        return;
      }
      reconnectAttemptsRef.current += 1;
      setPhase({ k: "pending" });
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = setTimeout(() => sendJoinRequestRef.current?.(), 1200);
    });
    return ws;
  }, [goReady]);

  const sendJoinRequest = useCallback(() => {
    setError(null);
    const ws = wsRef.current && wsRef.current.readyState === 1 ? wsRef.current : connectPairing();
    const payload = JSON.stringify({ t: "request", name: nameRef.current.trim().slice(0, 40) });
    if (ws.readyState === 1) ws.send(payload);
    else ws.addEventListener("open", () => ws.send(payload), { once: true });
    setPhase({ k: "pending" });
  }, [connectPairing]);
  const sendJoinRequestRef = useRef<(() => void) | null>(null);
  sendJoinRequestRef.current = sendJoinRequest;

  const onRequest = useCallback(() => {
    nameRef.current = name;
    reconnectAttemptsRef.current = 0;
    sendJoinRequest();
  }, [name, sendJoinRequest]);

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
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      try {
        wsRef.current?.close();
      } catch {
        // ignore
      }
    };
  }, []);

  if (phase.k === "ready") {
    return (
      <GuestReadyView
        serverId={phase.serverId}
        workspaceId={phase.workspaceId}
        workspaceCwd={phase.workspaceCwd}
        agentId={hint.agentId}
        capabilities={hint.capabilities}
      />
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

type GuestTab = "chat" | "files" | "changes" | "terminal";

// The connected guest surface: the real agent chat, plus (when the host granted them) read-only
// Files, Changes, and Terminal tabs backed by the real app panels, all confined to the shared
// agent's workspace by the daemon guest guard (ADR-0019).
function GuestReadyView({
  serverId,
  workspaceId,
  workspaceCwd,
  agentId,
  capabilities,
}: {
  serverId: string;
  workspaceId: string;
  workspaceCwd: string;
  agentId: string;
  capabilities: GuestShareCapabilities;
}): ReactElement {
  const [tab, setTab] = useState<GuestTab>("chat");
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);
  const [openTerminalId, setOpenTerminalId] = useState<string | null>(null);
  const showFiles = capabilities.files;
  const showTerminal = capabilities.terminal;
  const needsWorkspace = showFiles || showTerminal;
  // The session entry may not exist in the store yet when we first mount (the guest runtime fills
  // it asynchronously on connect), and mergeWorkspaces is a no-op until it does. Seed reactively
  // once the session appears so the Files/Changes/Terminal panels can resolve the workspace dir.
  const sessionReady = useSessionStore((s) => Boolean(s.sessions[serverId]));
  useEffect(() => {
    if (needsWorkspace && sessionReady && workspaceId && workspaceCwd) {
      seedGuestWorkspace(serverId, workspaceId, workspaceCwd);
    }
  }, [needsWorkspace, sessionReady, serverId, workspaceId, workspaceCwd]);
  const workspaceRoot = useWorkspaceDirectory(serverId, workspaceId) ?? "";

  // Subscribe to the shared agent's timeline so the guest receives LIVE agent_stream pushes (the
  // agent's responses). In the host app this is driven by the workspace screen registering "visible"
  // agents; the guest surface bypasses that, so without this the guest only ever sees its own message
  // and spins forever waiting for a reply. Prefer the app's viewedTimelineSync (it also repairs the
  // subscription on reconnect); fall back to a direct subscription when it isn't available.
  const viewedTimelineSync = useSessionStore(
    (s) => s.sessions[serverId]?.viewedTimelineSync ?? null,
  );
  const client = useSessionStore((s) => s.sessions[serverId]?.client ?? null);
  useEffect(() => {
    if (!sessionReady) return undefined;
    if (viewedTimelineSync) {
      viewedTimelineSync.replaceVisibleAgentIds("guest-share", [agentId]);
      return () => viewedTimelineSync.replaceVisibleAgentIds("guest-share", []);
    }
    if (client) void client.setAgentTimelineSubscription([agentId]).catch(() => undefined);
    return undefined;
  }, [sessionReady, viewedTimelineSync, client, agentId]);

  const target = useMemo<WorkspaceTabTarget>(() => {
    if (tab === "changes") return { kind: "working_diff" };
    if (tab === "files" && openFilePath) return { kind: "file", path: openFilePath };
    if (tab === "terminal" && openTerminalId)
      return { kind: "terminal", terminalId: openTerminalId };
    return { kind: "agent", agentId };
  }, [tab, openFilePath, openTerminalId, agentId]);

  const openFile = useCallback((filePath: string) => {
    setOpenFilePath(filePath);
    setTab("files");
  }, []);
  const closeFile = useCallback(() => setOpenFilePath(null), []);
  const closeTerminal = useCallback(() => setOpenTerminalId(null), []);

  const paneValue = useMemo<PaneContextValue>(
    () => ({
      serverId,
      workspaceId,
      tabId: "guest",
      target,
      openFileInWorkspace: (req) => openFile(req.location.path),
      openTab: (t) => {
        if (t.kind === "file") openFile(t.path);
      },
      closeCurrentTab: () => {},
      retargetCurrentTab: () => {},
      openImportSheet: () => {},
    }),
    [serverId, workspaceId, target, openFile],
  );

  let body: ReactElement | null = null;
  if (tab === "chat") {
    body = <AgentConversationPanel />;
  } else if (tab === "changes") {
    body = <WorkingDiffPanel />;
  } else if (tab === "terminal") {
    body = openTerminalId ? (
      <View style={styles.fileViewRoot}>
        <Pressable style={styles.backRow} onPress={closeTerminal}>
          <Text style={styles.backText}>‹ Terminals</Text>
        </Pressable>
        <View style={styles.paneBody}>
          <TerminalPanel />
        </View>
      </View>
    ) : (
      <GuestTerminalPicker
        serverId={serverId}
        workspaceRoot={workspaceRoot}
        onOpenTerminal={setOpenTerminalId}
      />
    );
  } else if (openFilePath) {
    body = (
      <View style={styles.fileViewRoot}>
        <Pressable style={styles.backRow} onPress={closeFile}>
          <Text style={styles.backText}>‹ Files</Text>
        </Pressable>
        <View style={styles.paneBody}>
          <FilePanel />
        </View>
      </View>
    );
  } else {
    body = (
      <FileExplorerPane
        serverId={serverId}
        workspaceId={workspaceId}
        workspaceRoot={workspaceRoot}
        onOpenFile={openFile}
      />
    );
  }

  return (
    <View style={styles.readyRoot}>
      {showFiles || showTerminal ? (
        <View style={styles.tabBar}>
          <GuestTabButton label="Chat" value="chat" active={tab === "chat"} onSelect={setTab} />
          {showFiles ? (
            <>
              <GuestTabButton
                label="Files"
                value="files"
                active={tab === "files"}
                onSelect={setTab}
              />
              <GuestTabButton
                label="Changes"
                value="changes"
                active={tab === "changes"}
                onSelect={setTab}
              />
            </>
          ) : null}
          {showTerminal ? (
            <GuestTabButton
              label="Terminal"
              value="terminal"
              active={tab === "terminal"}
              onSelect={setTab}
            />
          ) : null}
        </View>
      ) : null}
      <PaneProvider value={paneValue}>
        <PaneFocusProvider
          value={createPaneFocusContextValue({ isWorkspaceFocused: true, isPaneFocused: true })}
        >
          <View style={styles.paneBody}>{body}</View>
        </PaneFocusProvider>
      </PaneProvider>
    </View>
  );
}

// Read-only terminal picker for the guest: lists the shared workspace's terminals; selecting one
// opens it in the real TerminalPanel (input is rejected server-side — the guest can only watch).
function GuestTerminalPicker({
  serverId,
  workspaceRoot,
  onOpenTerminal,
}: {
  serverId: string;
  workspaceRoot: string;
  onOpenTerminal: (terminalId: string) => void;
}): ReactElement {
  const client = useSessionStore((s) => s.sessions[serverId]?.client ?? null);
  // Query by cwd only. The guest's synthetic workspaceId (the cwd) does not match the daemon's real
  // workspaceId for the terminal, so passing it would filter every terminal out.
  const terminalsQuery = useFetchQuery({
    queryKey: buildTerminalsQueryKey(serverId, workspaceRoot, null),
    enabled: Boolean(client && workspaceRoot),
    dataShape: "list",
    staleTimeMs: 4000,
    refetchInterval: 4000,
    queryFn: async () => {
      if (!client || !workspaceRoot) throw new Error("Workspace directory not found");
      return client.listTerminals(workspaceRoot);
    },
  });
  const terminals = terminalsQuery.data?.terminals ?? [];

  if (terminals.length === 0) {
    return (
      <View style={styles.terminalEmpty}>
        <Text style={styles.sub}>No terminals open in this workspace yet.</Text>
      </View>
    );
  }
  return (
    <View style={styles.terminalList}>
      {terminals.map((term) => (
        <GuestTerminalRow
          key={term.id}
          terminalId={term.id}
          label={term.title || term.name || term.id}
          onOpen={onOpenTerminal}
        />
      ))}
    </View>
  );
}

function GuestTerminalRow({
  terminalId,
  label,
  onOpen,
}: {
  terminalId: string;
  label: string;
  onOpen: (terminalId: string) => void;
}): ReactElement {
  const onPress = useCallback(() => onOpen(terminalId), [onOpen, terminalId]);
  return (
    <Pressable style={styles.terminalRow} onPress={onPress} testID="guest-terminal-row">
      <Text style={styles.terminalRowText}>{label}</Text>
    </Pressable>
  );
}

function GuestTabButton({
  label,
  value,
  active,
  onSelect,
}: {
  label: string;
  value: GuestTab;
  active: boolean;
  onSelect: (tab: GuestTab) => void;
}): ReactElement {
  const onPress = useCallback(() => onSelect(value), [onSelect, value]);
  return (
    <Pressable style={[styles.tabBtn, active ? styles.tabBtnActive : null]} onPress={onPress}>
      <Text style={[styles.tabBtnText, active ? styles.tabBtnTextActive : null]}>{label}</Text>
    </Pressable>
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
        <Pressable onPress={onRequest} hitSlop={8}>
          <Text style={styles.link}>Start over</Text>
        </Pressable>
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
        <Pressable onPress={onRequest} hitSlop={8}>
          <Text style={styles.link}>Get a new code</Text>
        </Pressable>
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
        onSubmitEditing={onRequest}
        returnKeyType="go"
        placeholder="Your name"
        placeholderTextColor={styles.mutedText.color}
        maxLength={40}
        autoFocus
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
  readyRoot: { flex: 1, backgroundColor: theme.colors.surface0 },
  paneBody: { flex: 1 },
  fileViewRoot: { flex: 1 },
  tabBar: {
    flexDirection: "row",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  tabBtn: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  tabBtnActive: { backgroundColor: theme.colors.surface2 },
  tabBtnText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  tabBtnTextActive: { color: theme.colors.foreground, fontWeight: theme.fontWeight.semibold },
  backRow: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  backText: { color: theme.colors.accent, fontSize: theme.fontSize.sm },
  terminalEmpty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 16 },
  terminalList: { padding: theme.spacing[2], gap: theme.spacing[1] },
  terminalRow: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  terminalRowText: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
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
  link: {
    color: theme.colors.accent,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
    marginTop: theme.spacing[2],
  },
}));
