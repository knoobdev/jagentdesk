import { useCallback, useMemo, useState, type ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import type {
  DaemonClient,
  SshConnectionStateEvent,
  SshGroup,
  SshIdentity,
  SshKey,
  SshServerInfo,
} from "@jagentdesk/client/internal/daemon-client";
import type { SnippetsApi } from "@/ssh/snippets/api";
import type { SnippetWorkspacePlan } from "@/ssh/snippets/snippet-input";
import type { SshServerLiveState } from "@/ssh/use-ssh-connect-events";
import type { Theme } from "@/styles/theme";
import { ServerFormSheet } from "./server-form-sheet";
import { ForwardingSection, ServerSftpSection, type SshModuleApis } from "./server-modules";
import {
  remoteDbEngines,
  ServerPanelBody,
  useServerEnvironment,
  type ServerPanel,
} from "./server-surfaces";
import { ServerSnippetsSection } from "./snippets-mount";
import {
  SshTerminalView,
  type ServerSection,
  type SessionMenuAction,
  type SessionMenuEntry,
  type SshConnectionErrorDetails,
} from "./ssh-terminal-view";

// The SSH session screen (spec 25.13.1): wires the tab bodies (SFTP, forwarding, snippets,
// Docker, logs) and the "⋯" actions (re-detect, install key, database / Kubernetes through the
// server, edit server) around SshTerminalView.

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

type SheetPanel = Extract<ServerPanel, "key" | "database" | "kubernetes">;

const SHEET_TITLES: Record<SheetPanel, string> = {
  key: "Install public key",
  database: "Add database via this server",
  kubernetes: "Import Kubernetes cluster via this server",
};

export interface SshSessionScreenProps {
  client: DaemonClient | null;
  hostServerId: string;
  server: SshServerInfo;
  servers: SshServerInfo[];
  groups: SshGroup[];
  identities: SshIdentity[];
  keys: SshKey[];
  moduleApis: SshModuleApis | null;
  snippetsApi: SnippetsApi | null;
  onOpenWorkspace: (plan: SnippetWorkspacePlan) => void;
  terminalId: string;
  live: SshServerLiveState | undefined;
  terminalState: SshConnectionStateEvent | undefined;
  insetsTop: number;
  onBack: () => void;
  onClosed: (terminalId: string) => void;
  onHostkeyDecision: (serverId: string, decision: "accept" | "reject") => void;
  onAuthSubmit: (serverId: string, answers: string[] | null) => void;
  refresh: () => Promise<void>;
}

function useSessionActions(input: {
  client: DaemonClient | null;
  terminalId: string;
  refresh: () => Promise<void>;
  onBack: () => void;
  onClosed: (terminalId: string) => void;
}) {
  const { client, terminalId, refresh, onBack, onClosed } = input;
  // Errors of actions taken in the tab stay visible in the tab (docs/testing.md).
  const [actionError, setActionError] = useState<string | null>(null);
  const run = useCallback(
    (task: (c: DaemonClient) => Promise<{ error: string | null } | void>, fallback: string) => {
      if (!client) return;
      void (async () => {
        try {
          const res = await task(client);
          setActionError(res ? res.error : null);
        } catch (error) {
          setActionError(errorText(error, fallback));
        }
      })();
    },
    [client],
  );
  const disconnect = useCallback(() => {
    if (!client) return;
    void (async () => {
      await client.killTerminal(terminalId).catch(() => undefined);
      onClosed(terminalId);
      onBack();
    })();
  }, [client, onBack, onClosed, terminalId]);
  const reconnect = useCallback(
    () => run((c) => c.sshSessionReconnect({ terminalId }), "Reconnect failed"),
    [run, terminalId],
  );
  // Mobile Password key (25.4): the daemon types the saved password; it never comes here.
  const typePassword = useCallback(
    () => run((c) => c.sshSessionTypePassword({ terminalId }), "Could not type the password"),
    [run, terminalId],
  );
  // After host_key_mismatch the user may trust the presented key (25.3): replace the stored
  // key with it (ssh.knownhosts.replace), then reconnect the same tab.
  const replaceHostKey = useCallback(
    (error: SshConnectionErrorDetails) => {
      const { host, port, receivedKeyType, receivedPublicKey } = error;
      if (!host || !port || !receivedKeyType || !receivedPublicKey) return;
      run(async (c) => {
        const res = await c.sshKnownhostsReplace({
          host,
          port,
          keyType: receivedKeyType,
          publicKey: receivedPublicKey,
        });
        if (res.error) return res;
        const reconnected = await c.sshSessionReconnect({ terminalId });
        await refresh();
        return reconnected;
      }, "Could not replace the host key");
    },
    [refresh, run, terminalId],
  );
  return { actionError, disconnect, reconnect, typePassword, replaceHostKey };
}

export function SshSessionScreen(props: SshSessionScreenProps) {
  const { client, hostServerId, server, servers, groups, keys, moduleApis, snippetsApi } = props;
  const { terminalId, terminalState, refresh } = props;
  const actions = useSessionActions(props);
  const connected = terminalState?.state === "connected";
  const { environment, redetect } = useServerEnvironment(client, server.id, connected);
  const [section, setSection] = useState("terminal");
  const [sheet, setSheet] = useState<SheetPanel | null>(null);
  const [editing, setEditing] = useState(false);
  const dbEngines = useMemo(() => remoteDbEngines(environment), [environment]);

  const sections = useMemo<ServerSection[]>(() => {
    const list: ServerSection[] = [{ id: "terminal", label: "Terminal" }];
    if (moduleApis) list.push({ id: "sftp", label: "SFTP" });
    if (moduleApis) list.push({ id: "forwarding", label: "Port forwarding" });
    if (snippetsApi) list.push({ id: "snippets", label: "Snippets" });
    if (environment?.docker) list.push({ id: "docker", label: "Docker" });
    list.push({ id: "logs", label: "Logs" });
    return list;
  }, [environment?.docker, moduleApis, snippetsApi]);

  const menu = useMemo<SessionMenuEntry[]>(() => {
    const entries: SessionMenuEntry[] = [
      { action: "redetect", label: "Re-detect environment" },
      { action: "install-key", label: "Install public key" },
    ];
    if (dbEngines.length > 0) entries.push({ action: "database", label: SHEET_TITLES.database });
    if (environment?.kubectl) {
      entries.push({ action: "kubernetes", label: SHEET_TITLES.kubernetes });
    }
    entries.push({ action: "edit-server", label: "Edit server" });
    return entries;
  }, [dbEngines.length, environment?.kubectl]);

  const handleMenu = useCallback(
    (action: SessionMenuAction) => {
      if (action === "redetect") redetect();
      else if (action === "install-key") setSheet("key");
      else if (action === "database") setSheet("database");
      else if (action === "kubernetes") setSheet("kubernetes");
      else setEditing(true);
    },
    [redetect],
  );
  const closeSheet = useCallback(() => setSheet(null), []);
  const closeEditor = useCallback(() => setEditing(false), []);
  const handleSaved = useCallback(() => {
    setEditing(false);
    void refresh();
  }, [refresh]);
  const handleServerSaved = useCallback(() => void refresh(), [refresh]);
  const sheetHeader = useMemo(() => ({ title: sheet ? SHEET_TITLES[sheet] : "" }), [sheet]);
  const editTarget = useMemo(() => {
    const { state: _state, lastError: _lastError, ...rest } = server;
    return { mode: "edit" as const, server: rest };
  }, [server]);

  let sectionContent: ReactNode = null;
  if (section === "sftp" && moduleApis) {
    sectionContent = (
      <ServerSftpSection
        apis={moduleApis}
        client={client}
        hostServerId={hostServerId}
        server={server}
        servers={servers}
      />
    );
  } else if (section === "forwarding" && moduleApis) {
    sectionContent = (
      <ForwardingSection
        apis={moduleApis}
        client={client}
        servers={servers}
        server={server}
        onServerSaved={handleServerSaved}
      />
    );
  } else if (section === "snippets" && snippetsApi) {
    sectionContent = (
      <ServerSnippetsSection
        api={snippetsApi}
        client={client}
        server={server}
        servers={servers}
        groups={groups}
        terminalId={terminalId}
        onOpenWorkspace={props.onOpenWorkspace}
      />
    );
  } else if ((section === "docker" || section === "logs") && client) {
    sectionContent = (
      <ScrollView style={styles.panelScroll} contentContainerStyle={styles.panelContent}>
        <ServerPanelBody
          panel={section}
          client={client}
          hostServerId={hostServerId}
          server={server}
          keys={keys}
          dbEngines={dbEngines}
        />
      </ScrollView>
    );
  }

  return (
    <>
      <SshTerminalView
        hostServerId={hostServerId}
        server={server}
        groups={groups}
        terminalId={terminalId}
        live={props.live}
        terminalState={terminalState}
        environment={environment}
        insetsTop={props.insetsTop}
        sections={sections}
        section={section}
        onSectionChange={setSection}
        sectionContent={sectionContent}
        menu={menu}
        onMenu={handleMenu}
        onBack={props.onBack}
        onEndSession={actions.disconnect}
        onHostkeyDecision={props.onHostkeyDecision}
        onAuthSubmit={props.onAuthSubmit}
        onReplaceHostKey={actions.replaceHostKey}
        onReconnect={actions.reconnect}
        onTypePassword={actions.typePassword}
        actionError={actions.actionError}
      />
      {sheet && client ? (
        <AdaptiveModalSheet
          visible
          header={sheetHeader}
          onClose={closeSheet}
          onDismiss={closeSheet}
        >
          <View style={styles.sheetBody}>
            <ServerPanelBody
              panel={sheet}
              client={client}
              hostServerId={hostServerId}
              server={server}
              keys={keys}
              dbEngines={dbEngines}
            />
          </View>
        </AdaptiveModalSheet>
      ) : null}
      {editing ? (
        <ServerFormSheet
          client={client}
          target={editTarget}
          groups={groups}
          identities={props.identities}
          servers={servers}
          onClose={closeEditor}
          onSaved={handleSaved}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  panelScroll: { flex: 1, minHeight: 0 },
  panelContent: { padding: theme.spacing[3], gap: theme.spacing[3], flexGrow: 1 },
  sheetBody: { padding: theme.spacing[3], gap: theme.spacing[3] },
}));
