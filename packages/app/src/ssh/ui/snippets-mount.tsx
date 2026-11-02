import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { TerminalPane } from "@/components/terminal-pane";
import type {
  DaemonClient,
  SshConnectionStateEvent,
  SshServerInfo,
} from "@jagentdesk/client/internal/daemon-client";
import type {
  SshSnippetRun,
  SshWorkspaceTemplate,
} from "@jagentdesk/protocol/ssh/snippets-schemas";
import { createSnippetsApi, type SnippetsApi } from "@/ssh/snippets/api";
import { CommandHistoryList } from "@/ssh/snippets/command-history-list";
import type { SshRpcIo } from "@/ssh/snippets/rpc-io";
import { SnippetLibrary } from "@/ssh/snippets/snippet-library";
import { SnippetRunResults } from "@/ssh/snippets/snippet-run-results";
import type { SnippetWorkspacePlan } from "@/ssh/snippets/snippet-input";
import {
  focusPane,
  paneIds,
  getPane,
  type PaneNode,
  type SplitWorkspace,
} from "@/ssh/snippets/split-layout";
import { SplitWorkspaceView } from "@/ssh/snippets/split-workspace-view";
import { WorkspaceTemplatesList } from "@/ssh/snippets/workspace-templates-list";
import { fgTint, IconBtn, ThemedArrowLeft } from "./primitives";
import { sshStyles as styles } from "./styles";

// Mounts the S5 module (spec 25.4, 25.7): snippet library + multi-server runs, command
// history, workspace templates and the split workspace that opens one SSH session per pane.

/** SshRpcIo on top of DaemonClient (raw ssh.* send + raw message stream). */
export function useSnippetsApi(
  client: DaemonClient | null,
  hostServerId: string,
): SnippetsApi | null {
  return useMemo(() => {
    if (!client) return null;
    const io: SshRpcIo = {
      send: (message) =>
        client.sendSshModuleMessage(message as { type: `ssh.${string}` } & typeof message),
      subscribe: (handler) => client.subscribeRawMessages(handler),
    };
    return createSnippetsApi(io, hostServerId);
  }, [client, hostServerId]);
}

function useServerOptions(servers: SshServerInfo[]) {
  const options = useMemo(
    () =>
      servers.map((server) => ({ id: server.id, label: server.label, address: server.address })),
    [servers],
  );
  const labels = useMemo(
    () => Object.fromEntries(servers.map((server) => [server.id, server.label])),
    [servers],
  );
  return { options, labels };
}

/** The Servers screen "Snippets" tab: library, run results, workspace templates. */
export function SnippetsTab({
  api,
  servers,
  onOpenWorkspace,
}: {
  api: SnippetsApi;
  servers: SshServerInfo[];
  onOpenWorkspace: (plan: SnippetWorkspacePlan) => void;
}) {
  const { options, labels } = useServerOptions(servers);
  const [run, setRun] = useState<SshSnippetRun | null>(null);
  const closeRun = useCallback(() => setRun(null), []);
  const openTemplate = useCallback(
    (workspace: SplitWorkspace, _template: SshWorkspaceTemplate) =>
      onOpenWorkspace({ workspace, inputByPaneId: {} }),
    [onOpenWorkspace],
  );
  if (run) {
    return <SnippetRunResults api={api} run={run} serverLabels={labels} onClose={closeRun} />;
  }
  return (
    <View style={styles.forwardingSection}>
      <SnippetLibrary
        api={api}
        servers={options}
        onRunInWorkspace={onOpenWorkspace}
        onRunStarted={setRun}
      />
      <WorkspaceTemplatesList api={api} serverLabels={labels} onOpen={openTemplate} />
    </View>
  );
}

/** A server's "Snippets" section: run/paste into this terminal, and its command history. */
export function ServerSnippetsSection({
  api,
  client,
  server,
  servers,
  terminalId,
  onOpenWorkspace,
}: {
  api: SnippetsApi;
  client: DaemonClient | null;
  server: SshServerInfo;
  servers: SshServerInfo[];
  terminalId: string;
  onOpenWorkspace: (plan: SnippetWorkspacePlan) => void;
}) {
  const { options, labels } = useServerOptions(servers);
  const [run, setRun] = useState<SshSnippetRun | null>(null);
  const closeRun = useCallback(() => setRun(null), []);
  const insert = useCallback(
    (input: string) => client?.sendTerminalInput(terminalId, { type: "input", data: input }),
    [client, terminalId],
  );
  if (run) {
    return <SnippetRunResults api={api} run={run} serverLabels={labels} onClose={closeRun} />;
  }
  return (
    <View style={styles.forwardingSection} testID="ssh-server-snippets">
      <SnippetLibrary
        api={api}
        servers={options}
        onInsert={insert}
        onRunInWorkspace={onOpenWorkspace}
        onRunStarted={setRun}
      />
      <CommandHistoryList api={api} serverId={server.id} servers={options} onInsert={insert} />
    </View>
  );
}

interface PaneSession {
  terminalId: string | null;
  error: string | null;
}

/**
 * A split workspace (25.4 / 25.7): one SSH session per server pane, each pane its own
 * TerminalPane; a pane's planned input (snippet) is typed once its session connects.
 */
export function SshWorkspaceScreen({
  client,
  hostServerId,
  plan,
  servers,
  stateByTerminalId,
  insetsTop,
  onClose,
}: {
  client: DaemonClient | null;
  hostServerId: string;
  plan: SnippetWorkspacePlan;
  servers: SshServerInfo[];
  stateByTerminalId: Readonly<Record<string, SshConnectionStateEvent>>;
  insetsTop: number;
  onClose: () => void;
}) {
  const [workspace, setWorkspace] = useState(plan.workspace);
  const [sessions, setSessions] = useState<Record<string, PaneSession>>({});
  const sent = useRef(new Set<string>());
  const labels = useMemo(
    () => new Map(servers.map((server) => [server.id, server.label])),
    [servers],
  );

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    const open = async (paneId: string, serverId: string) => {
      try {
        const res = await client.sshSessionCreate({ serverId, size: { cols: 80, rows: 24 } });
        if (cancelled) return;
        setSessions((current) => ({
          ...current,
          [paneId]: { terminalId: res.terminalId, error: res.error },
        }));
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "Could not open the session";
        setSessions((current) => ({ ...current, [paneId]: { terminalId: null, error: message } }));
      }
    };
    for (const paneId of paneIds(plan.workspace)) {
      const pane = getPane(plan.workspace, paneId);
      if (pane.target.kind === "server") void open(paneId, pane.target.serverId);
    }
    return () => {
      cancelled = true;
    };
  }, [client, plan.workspace]);

  // Type each pane's planned input once its session reports connected.
  useEffect(() => {
    if (!client) return;
    for (const [paneId, session] of Object.entries(sessions)) {
      const input = plan.inputByPaneId[paneId];
      const terminalId = session.terminalId;
      if (!input || !terminalId || sent.current.has(paneId)) continue;
      if (stateByTerminalId[terminalId]?.state !== "connected") continue;
      sent.current.add(paneId);
      client.sendTerminalInput(terminalId, { type: "input", data: input });
    }
  }, [client, plan.inputByPaneId, sessions, stateByTerminalId]);

  const handleFocus = useCallback(
    (paneId: string) => setWorkspace((current) => focusPane(current, paneId)),
    [],
  );
  const paneLabel = useCallback(
    (pane: PaneNode) =>
      pane.tabTitle ??
      (pane.target.kind === "server" ? labels.get(pane.target.serverId) : null) ??
      "Terminal",
    [labels],
  );
  const renderPane = useCallback(
    (pane: PaneNode) => {
      const session = sessions[pane.id];
      if (session?.error) return <Text style={styles.errorText}>{session.error}</Text>;
      if (!session?.terminalId) return <Text style={styles.noticeBody}>Connecting…</Text>;
      return (
        <TerminalPane
          serverId={hostServerId}
          cwd={`ssh:${session.terminalId}`}
          terminalId={session.terminalId}
          isWorkspaceFocused
          isPaneFocused={workspace.focusedPaneId === pane.id}
          onOpenFileExplorer={noop}
          onOpenWorkspaceFile={noop}
        />
      );
    },
    [hostServerId, sessions, workspace.focusedPaneId],
  );
  return (
    <View style={styles.terminalScreen} testID="ssh-workspace-screen">
      <View style={[styles.terminalHeader, { paddingTop: insetsTop + 8 }]}>
        <IconBtn
          icon={ThemedArrowLeft}
          tint={fgTint}
          label="Back to servers"
          onPress={onClose}
          testID="ssh-workspace-back"
        />
        <Text style={styles.cellStrong}>{`Workspace · ${paneIds(workspace).length} panes`}</Text>
      </View>
      <SplitWorkspaceView
        workspace={workspace}
        renderPane={renderPane}
        onFocusPane={handleFocus}
        paneLabel={paneLabel}
      />
    </View>
  );
}

const noop = () => {};
