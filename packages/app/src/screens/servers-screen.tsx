import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { router, useLocalSearchParams } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { FolderPlus, Plus, Server as ServerIcon } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PageHeader } from "@/components/headers/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton, useSkeletonPulse } from "@/components/ui/skeleton";
import { confirmDialog } from "@/utils/confirm-dialog";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import type {
  DaemonClient,
  SshGroup,
  SshIdentity,
  SshKey,
  SshKnownHost,
  SshServerInfo,
} from "@jagentdesk/client/internal/daemon-client";
import { flattenServerRows, formatServerTarget } from "@/ssh/group-tree";
import { collectTags, serverHasAllTags, serverMatchesQuery, toggleTagIn } from "@/ssh/tag-filter";
import { useServersData, type ServersData } from "@/ssh/use-servers-data";
import { useSshConnectEvents, type SshServerLiveState } from "@/ssh/use-ssh-connect-events";
import { KeychainTab, KnownHostsTab, type KeychainActions } from "@/ssh/ui/keychain-tab";
import {
  descendantGroupIds,
  GroupFormSheet,
  IdentityFormSheet,
  KeyFormSheet,
  type GroupFormTarget,
  type IdentityFormTarget,
} from "@/ssh/ui/keychain-sheets";
import { ErrorBanner, TabButton } from "@/ssh/ui/primitives";
import { AuthPromptBar, HostkeyPromptBar } from "@/ssh/ui/prompt-bars";
import { ServerFormSheet, type ServerFormTarget } from "@/ssh/ui/server-form-sheet";
import { ServersListTab, type ServerListActions } from "@/ssh/ui/servers-list";
import { SshSessionScreen } from "@/ssh/ui/session-screen";
import { sshStyles as styles } from "@/ssh/ui/styles";
import { ImportServersSheet } from "@/ssh/ui/server-surfaces";
import { ForwardingSection, useSshModuleApis, type SshModuleApis } from "@/ssh/ui/server-modules";
import { SnippetsTab, SshWorkspaceScreen, useSnippetsApi } from "@/ssh/ui/snippets-mount";
import type { SnippetsApi } from "@/ssh/snippets/api";
import type { SshTabStatusState } from "@/ssh/tab-status/tab-status-state";
import { useSshTabStatuses } from "@/ssh/tab-status/use-ssh-tab-status";
import { OpenSessionsBar } from "@/ssh/ui/open-sessions";
import type { SnippetWorkspacePlan } from "@/ssh/snippets/snippet-input";

// Servers screen (spec 25.13, milestone S1): the saved SSH servers of the daemon this
// route points at, Keychain, Known hosts, and SSH terminal tabs. Same layout on desktop
// and mobile (full-width list; a terminal takes the whole screen).

type ServersTabId = "servers" | "keychain" | "hosts" | "forwarding" | "snippets";

// Sections next to a server's terminal (spec 25.13), provided by the milestone modules.

interface ActiveTerminal {
  sshServerId: string;
  terminalId: string;
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function stripRuntimeFields(server: SshServerInfo) {
  const { state: _state, lastError: _lastError, ...rest } = server;
  return rest;
}

function ServersSkeleton() {
  const pulse = useSkeletonPulse();
  return (
    <View style={styles.skeletonStack}>
      <Skeleton width="38%" height={30} pulse={pulse} radius={12} />
      <Skeleton width="100%" height={44} pulse={pulse} radius={12} />
      <Skeleton width="100%" height={44} pulse={pulse} radius={12} />
      <Skeleton width="100%" height={44} pulse={pulse} radius={12} />
    </View>
  );
}

/** Prompts for connections without an open tab (e.g. started by an agent tool). */
function PendingPrompts({
  servers,
  liveByServerId,
  onHostkeyDecision,
  onAuthSubmit,
}: {
  servers: SshServerInfo[];
  liveByServerId: Readonly<Record<string, SshServerLiveState>>;
  onHostkeyDecision: (serverId: string, decision: "accept" | "reject") => void;
  onAuthSubmit: (serverId: string, answers: string[] | null) => void;
}) {
  const pending = Object.entries(liveByServerId).filter(
    ([, live]) => live.hostkeyPrompt !== null || live.authPrompt !== null,
  );
  return (
    <>
      {pending.map(([serverId, live]) => (
        <View key={serverId} style={styles.promptStack}>
          <Text style={styles.cellStrong}>
            {servers.find((candidate) => candidate.id === serverId)?.label ?? serverId}
          </Text>
          <HostkeyPromptBar serverId={serverId} live={live} onDecision={onHostkeyDecision} />
          <AuthPromptBar serverId={serverId} live={live} onSubmit={onAuthSubmit} />
        </View>
      ))}
    </>
  );
}

type ConfirmOptions = Parameters<typeof confirmDialog>[0];
type RpcCall = (client: DaemonClient) => Promise<{ error: string | null }>;

/** Confirm, call, then refresh — or keep the daemon's error visible (docs/testing.md). */
function useConfirmAndRun(input: {
  client: DaemonClient | null;
  refresh: () => Promise<void>;
  setError: (error: string | null) => void;
}) {
  const { client, refresh, setError } = input;
  return useCallback(
    async (confirm: ConfirmOptions, run: RpcCall) => {
      if (!client) return;
      if (!(await confirmDialog(confirm))) return;
      try {
        const res = await run(client);
        if (res.error) setError(res.error);
        else await refresh();
      } catch (error) {
        setError(errorText(error, "The request failed"));
      }
    },
    [client, refresh, setError],
  );
}

function useKeychainActions(input: {
  client: DaemonClient | null;
  confirmAndRun: ReturnType<typeof useConfirmAndRun>;
  setError: (error: string | null) => void;
  setKeySheet: (mode: "generate" | "import" | null) => void;
  setIdentityForm: (target: IdentityFormTarget | null) => void;
}): KeychainActions {
  const { client, confirmAndRun, setError, setKeySheet, setIdentityForm } = input;
  const copyPublicKey = useCallback(
    async (key: SshKey) => {
      if (!client) return;
      try {
        const res = await client.sshKeysExportPublic({ id: key.id });
        if (res.error || !res.publicKey) {
          setError(res.error ?? "Failed to export the public key");
          return;
        }
        await Clipboard.setStringAsync(res.publicKey);
      } catch (error) {
        setError(errorText(error, "Failed to export the public key"));
      }
    },
    [client, setError],
  );
  return useMemo<KeychainActions>(
    () => ({
      onGenerate: () => setKeySheet("generate"),
      onImport: () => setKeySheet("import"),
      onCopyPublicKey: (key: SshKey) => void copyPublicKey(key),
      onDeleteKey: (key: SshKey) =>
        void confirmAndRun(
          {
            title: "Delete key?",
            message: `"${key.label}" and its private key are removed from the daemon. Identities using it lose the key.`,
            confirmLabel: "Delete",
            destructive: true,
          },
          (c) => c.sshKeysDelete({ id: key.id }),
        ),
      onAddIdentity: () => setIdentityForm({ mode: "create", identity: null }),
      onEditIdentity: (identity: SshIdentity) => setIdentityForm({ mode: "edit", identity }),
      onDeleteIdentity: (identity: SshIdentity) =>
        void confirmAndRun(
          {
            title: "Delete identity?",
            message: `"${identity.label}" and its saved password are removed.`,
            confirmLabel: "Delete",
            destructive: true,
          },
          (c) => c.sshIdentitiesDelete({ id: identity.id }),
        ),
    }),
    [confirmAndRun, copyPublicKey, setIdentityForm, setKeySheet],
  );
}

function useConnect(input: {
  client: DaemonClient | null;
  data: ServersData;
  addSession: ReturnType<typeof useServersData>["addSession"];
  setError: (error: string | null) => void;
  openTerminal: (next: ActiveTerminal) => void;
}) {
  const { client, data, addSession, setError, openTerminal } = input;
  const [busyId, setBusyId] = useState<string | null>(null);
  const create = useCallback(
    async (server: SshServerInfo): Promise<string | null> => {
      if (!client) return null;
      const res = await client.sshSessionCreate({
        serverId: server.id,
        size: { cols: 80, rows: 24 },
      });
      if (res.error || !res.terminalId) {
        setError(res.error ?? "Failed to open the SSH session");
        return null;
      }
      addSession({
        terminalId: res.terminalId,
        serverId: server.id,
        state: "connecting",
        createdAtMs: Date.now(),
      });
      return res.terminalId;
    },
    [addSession, client, setError],
  );
  const connect = useCallback(
    async (server: SshServerInfo) => {
      const open = data.sessions.find((session) => session.serverId === server.id);
      if (open) {
        openTerminal({ sshServerId: server.id, terminalId: open.terminalId });
        return;
      }
      setBusyId(server.id);
      setError(null);
      try {
        const terminalId = await create(server);
        if (terminalId) openTerminal({ sshServerId: server.id, terminalId });
      } catch (error) {
        setError(errorText(error, "Failed to open the SSH session"));
      } finally {
        setBusyId(null);
      }
    },
    [create, data.sessions, openTerminal, setError],
  );
  // Group "connect all" (25.13): one session per server in the subtree; show the first.
  const connectGroup = useCallback(
    async (group: SshGroup) => {
      const groupIds = descendantGroupIds(data.groups, group.id).add(group.id);
      const targets = data.servers.filter(
        (server) => server.groupId !== undefined && groupIds.has(server.groupId),
      );
      let first: ActiveTerminal | null = null;
      try {
        for (const server of targets) {
          const terminalId = await create(server);
          if (terminalId && !first) first = { sshServerId: server.id, terminalId };
        }
      } catch (error) {
        setError(errorText(error, "Failed to open the SSH sessions"));
      }
      if (first) openTerminal(first);
    },
    [create, data.groups, data.servers, openTerminal, setError],
  );
  return { busyId, connect, connectGroup };
}

function useListActions(input: {
  connect: (server: SshServerInfo) => Promise<void>;
  connectGroup: (group: SshGroup) => Promise<void>;
  confirmAndRun: ReturnType<typeof useConfirmAndRun>;
  setServerForm: (target: ServerFormTarget | null) => void;
  setGroupForm: (target: GroupFormTarget | null) => void;
  setCollapsedGroupIds: (update: (prev: ReadonlySet<string>) => ReadonlySet<string>) => void;
}): ServerListActions {
  const {
    connect,
    connectGroup,
    confirmAndRun,
    setServerForm,
    setGroupForm,
    setCollapsedGroupIds,
  } = input;
  return useMemo<ServerListActions>(
    () => ({
      onConnect: (server) => void connect(server),
      onConnectGroup: (group) => void connectGroup(group),
      onEdit: (server) => setServerForm({ mode: "edit", server: stripRuntimeFields(server) }),
      onDuplicate: (server) =>
        setServerForm({
          mode: "duplicate",
          server: {
            ...stripRuntimeFields(server),
            id: "",
            label: `${server.label} copy`,
            hasPassword: false,
          },
        }),
      onDelete: (server) =>
        void confirmAndRun(
          {
            title: "Delete server?",
            message: `"${server.label}" and its saved password are removed. Open sessions to it close.`,
            confirmLabel: "Delete",
            destructive: true,
          },
          (c) => c.sshServersDelete({ id: server.id }),
        ),
      onEditGroup: (group) => setGroupForm({ mode: "edit", group }),
      onDeleteGroup: (group) =>
        void confirmAndRun(
          {
            title: "Delete group?",
            message: `"${group.label}" is removed. Its servers and sub-groups move up one level.`,
            confirmLabel: "Delete",
            destructive: true,
          },
          (c) => c.sshGroupsDelete({ id: group.id }),
        ),
      onToggleGroup: (groupId) =>
        setCollapsedGroupIds((prev) => {
          const next = new Set(prev);
          if (next.has(groupId)) next.delete(groupId);
          else next.add(groupId);
          return next;
        }),
      onAddServer: () => setServerForm({ mode: "create", server: null }),
    }),
    [confirmAndRun, connect, connectGroup, setCollapsedGroupIds, setGroupForm, setServerForm],
  );
}

function useServerRows(input: {
  data: ServersData;
  collapsedGroupIds: ReadonlySet<string>;
  selectedTags: ReadonlySet<string>;
  query: string;
}) {
  const { data, collapsedGroupIds, selectedTags, query } = input;
  const tags = useMemo(() => collectTags(data.servers), [data.servers]);
  const rows = useMemo(
    () =>
      flattenServerRows({
        servers: data.servers,
        groups: data.groups,
        collapsedGroupIds,
        serverFilter: (candidate) =>
          serverHasAllTags(candidate, selectedTags) &&
          serverMatchesQuery(candidate, query, formatServerTarget(candidate, data.groups)),
      }),
    [collapsedGroupIds, data.groups, data.servers, query, selectedTags],
  );
  return { tags, rows };
}

/**
 * `?connect=<serverId>` (the left-column server list, 25.13.1): open that server's session,
 * reusing an open one, then show it.
 */
function useConnectParam(input: {
  client: DaemonClient | null;
  data: ServersData;
  addSession: ReturnType<typeof useServersData>["addSession"];
  setError: (error: string | null) => void;
  connect: string | undefined;
}) {
  const { client, data, addSession, setError, connect } = input;
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!connect || !client || data.loading || handled.current === connect) return;
    handled.current = connect;
    const open = data.sessions.find((session) => session.serverId === connect);
    if (open) {
      router.setParams({ sshTerminal: open.terminalId, connect: undefined });
      handled.current = null;
      return;
    }
    void (async () => {
      try {
        const res = await client.sshSessionCreate({
          serverId: connect,
          size: { cols: 80, rows: 24 },
        });
        if (res.error || !res.terminalId) {
          setError(res.error ?? "Failed to open the SSH session");
          router.setParams({ connect: undefined });
          return;
        }
        addSession({
          terminalId: res.terminalId,
          serverId: connect,
          state: "connecting",
          createdAtMs: Date.now(),
        });
        router.setParams({ sshTerminal: res.terminalId, connect: undefined });
      } catch (error) {
        setError(errorText(error, "Failed to open the SSH session"));
        router.setParams({ connect: undefined });
      } finally {
        handled.current = null;
      }
    })();
  }, [addSession, client, connect, data.loading, data.sessions, setError]);
}

export function ServersScreen() {
  const hosts = useHosts();
  const params = useLocalSearchParams<{
    serverId?: string | string[];
    sshTerminal?: string | string[];
    connect?: string | string[];
  }>();
  const hostServerId = firstParam(params.serverId) ?? hosts[0]?.serverId ?? "";
  const client = useHostRuntimeClient(hostServerId);
  const insets = useSafeAreaInsets();
  const { data, refresh, setError, addSession, removeSession } = useServersData(client);
  const { liveByServerId, stateByTerminalId, respondHostkey, respondAuth } =
    useSshConnectEvents(client);
  const moduleApis = useSshModuleApis(client);
  const snippetsApi = useSnippetsApi(client, hostServerId);
  const [workspacePlan, setWorkspacePlan] = useState<SnippetWorkspacePlan | null>(null);
  const closeWorkspace = useCallback(() => setWorkspacePlan(null), []);

  // The open terminal lives in the URL (`?sshTerminal=`), so a reopened app returns to it
  // while the daemon still has the session (spec 25.16 #4).
  const routeTerminal = firstParam(params.sshTerminal);
  const activeSession = routeTerminal
    ? data.sessions.find((session) => session.terminalId === routeTerminal)
    : undefined;
  const terminalServer = activeSession
    ? data.servers.find((candidate) => candidate.id === activeSession.serverId)
    : undefined;
  const closeTerminal = useCallback(() => {
    router.setParams({ sshTerminal: undefined });
  }, []);
  useConnectParam({ client, data, addSession, setError, connect: firstParam(params.connect) });
  const tabStatuses = useSshTabStatuses({
    client,
    sessions: data.sessions,
    focusedTerminalId: activeSession?.terminalId ?? null,
  });

  if (workspacePlan) {
    return (
      <SshWorkspaceScreen
        client={client}
        hostServerId={hostServerId}
        plan={workspacePlan}
        servers={data.servers}
        groups={data.groups}
        stateByTerminalId={stateByTerminalId}
        insetsTop={insets.top}
        onClose={closeWorkspace}
      />
    );
  }
  if (activeSession && terminalServer) {
    return (
      <SshSessionScreen
        client={client}
        hostServerId={hostServerId}
        server={terminalServer}
        servers={data.servers}
        groups={data.groups}
        identities={data.identities}
        keys={data.keys}
        moduleApis={moduleApis}
        snippetsApi={snippetsApi}
        onOpenWorkspace={setWorkspacePlan}
        terminalId={activeSession.terminalId}
        live={liveByServerId[terminalServer.id]}
        terminalState={stateByTerminalId[activeSession.terminalId]}
        insetsTop={insets.top}
        onBack={closeTerminal}
        onClosed={removeSession}
        onHostkeyDecision={respondHostkey}
        onAuthSubmit={respondAuth}
        refresh={refresh}
      />
    );
  }
  return (
    <ServersHome
      client={client}
      data={data}
      refresh={refresh}
      setError={setError}
      addSession={addSession}
      moduleApis={moduleApis}
      snippetsApi={snippetsApi}
      onOpenWorkspace={setWorkspacePlan}
      tabStatuses={tabStatuses}
      liveByServerId={liveByServerId}
      onHostkeyDecision={respondHostkey}
      onAuthSubmit={respondAuth}
    />
  );
}

function ServersHome({
  client,
  data,
  refresh,
  setError,
  addSession,
  moduleApis,
  snippetsApi,
  onOpenWorkspace,
  tabStatuses,
  liveByServerId,
  onHostkeyDecision,
  onAuthSubmit,
}: {
  client: DaemonClient | null;
  data: ServersData;
  refresh: () => Promise<void>;
  setError: (error: string | null) => void;
  addSession: ReturnType<typeof useServersData>["addSession"];
  moduleApis: SshModuleApis | null;
  snippetsApi: SnippetsApi | null;
  onOpenWorkspace: (plan: SnippetWorkspacePlan) => void;
  tabStatuses: Readonly<Record<string, SshTabStatusState>>;
  liveByServerId: Readonly<Record<string, SshServerLiveState>>;
  onHostkeyDecision: (serverId: string, decision: "accept" | "reject") => void;
  onAuthSubmit: (serverId: string, answers: string[] | null) => void;
}) {
  const isCompact = useIsCompactFormFactor();
  const [tab, setTab] = useState<ServersTabId>("servers");
  const [query, setQuery] = useState("");
  const [selectedTags, setSelectedTags] = useState<ReadonlySet<string>>(new Set());
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<ReadonlySet<string>>(new Set());
  const [serverForm, setServerForm] = useState<ServerFormTarget | null>(null);
  const [groupForm, setGroupForm] = useState<GroupFormTarget | null>(null);
  const [identityForm, setIdentityForm] = useState<IdentityFormTarget | null>(null);
  const [keySheet, setKeySheet] = useState<"generate" | "import" | null>(null);

  const openTerminal = useCallback((next: ActiveTerminal) => {
    router.setParams({ sshTerminal: next.terminalId });
  }, []);
  const openTerminalById = useCallback((terminalId: string) => {
    router.setParams({ sshTerminal: terminalId });
  }, []);
  const confirmAndRun = useConfirmAndRun({ client, refresh, setError });
  const keychainActions = useKeychainActions({
    client,
    confirmAndRun,
    setError,
    setKeySheet,
    setIdentityForm,
  });
  const { busyId, connect, connectGroup } = useConnect({
    client,
    data,
    addSession,
    setError,
    openTerminal,
  });
  const listActions = useListActions({
    connect,
    connectGroup,
    confirmAndRun,
    setServerForm,
    setGroupForm,
    setCollapsedGroupIds,
  });
  const { tags, rows } = useServerRows({ data, collapsedGroupIds, selectedTags, query });

  const handleDeleteKnownHost = useCallback(
    (host: SshKnownHost) =>
      void confirmAndRun(
        {
          title: "Forget host key?",
          message: `The next connection to ${host.host}:${host.port} asks you to trust its key again.`,
          confirmLabel: "Forget",
          destructive: true,
        },
        (c) => c.sshKnownhostsDelete({ host: host.host, port: host.port, keyType: host.keyType }),
      ),
    [confirmAndRun],
  );
  const handleToggleTag = useCallback(
    (tag: string) => setSelectedTags((prev) => toggleTagIn(prev, tag)),
    [],
  );
  const [importOpen, setImportOpen] = useState(false);
  const closeSheets = useCallback(() => {
    setImportOpen(false);
    setServerForm(null);
    setGroupForm(null);
    setIdentityForm(null);
    setKeySheet(null);
  }, []);
  const handleSaved = useCallback(() => {
    closeSheets();
    void refresh();
  }, [closeSheets, refresh]);
  const handleAddGroup = useCallback(() => setGroupForm({ mode: "create", group: null }), []);
  const handleAddServer = useCallback(() => setServerForm({ mode: "create", server: null }), []);
  const handleImport = useCallback(() => setImportOpen(true), []);
  const headerActions = useMemo(
    () => (
      <ServersHeaderActions
        onAddGroup={handleAddGroup}
        onAddServer={handleAddServer}
        onImport={handleImport}
      />
    ),
    [handleAddGroup, handleAddServer, handleImport],
  );

  return (
    <>
      <PageHeader
        icon={ServerIcon}
        title="Servers"
        description="SSH servers saved on this daemon. Sessions run on the daemon and keep going when the app closes."
        actions={headerActions}
      />
      <ScrollView
        style={styles.container}
        contentContainerStyle={[styles.contentContainer, styles.contentBelowHeader]}
        keyboardShouldPersistTaps="handled"
      >
        {data.loading ? <ServersSkeleton /> : null}
        {!data.loading && data.error ? <ErrorBanner message={data.error} /> : null}
        {data.loading ? null : (
          <>
            <OpenSessionsBar
              sessions={data.sessions}
              servers={data.servers}
              statuses={tabStatuses}
              onOpen={openTerminalById}
            />
            <PendingPrompts
              servers={data.servers}
              liveByServerId={liveByServerId}
              onHostkeyDecision={onHostkeyDecision}
              onAuthSubmit={onAuthSubmit}
            />
            <View style={styles.tabRow}>
              <TabButton
                label={`Servers · ${data.servers.length}`}
                value="servers"
                active={tab === "servers"}
                onSelect={setTab}
                testID="servers-tab-servers"
              />
              <TabButton
                label="Keychain"
                value="keychain"
                active={tab === "keychain"}
                onSelect={setTab}
                testID="servers-tab-keychain"
              />
              <TabButton
                label="Known hosts"
                value="hosts"
                active={tab === "hosts"}
                onSelect={setTab}
                testID="servers-tab-hosts"
              />
              {snippetsApi ? (
                <TabButton
                  label="Snippets"
                  value="snippets"
                  active={tab === "snippets"}
                  onSelect={setTab}
                  testID="servers-tab-snippets"
                />
              ) : null}
              {moduleApis ? (
                <TabButton
                  label="Port forwarding"
                  value="forwarding"
                  active={tab === "forwarding"}
                  onSelect={setTab}
                  testID="servers-tab-forwarding"
                />
              ) : null}
            </View>
            {tab === "servers" ? (
              <ServersListTab
                rows={rows}
                groups={data.groups}
                tags={tags}
                query={query}
                onQueryChange={setQuery}
                selectedTags={selectedTags}
                onToggleTag={handleToggleTag}
                collapsedGroupIds={collapsedGroupIds}
                busyId={busyId}
                sessions={data.sessions}
                isCompact={isCompact}
                actions={listActions}
              />
            ) : null}
            {tab === "keychain" ? (
              <KeychainTab
                keys={data.keys}
                identities={data.identities}
                actions={keychainActions}
              />
            ) : null}
            {tab === "hosts" ? (
              <KnownHostsTab knownHosts={data.knownHosts} onDelete={handleDeleteKnownHost} />
            ) : null}
            {tab === "snippets" && snippetsApi ? (
              <SnippetsTab
                api={snippetsApi}
                servers={data.servers}
                groups={data.groups}
                onOpenWorkspace={onOpenWorkspace}
              />
            ) : null}
            {tab === "forwarding" && moduleApis ? (
              <ForwardingSection apis={moduleApis} client={client} servers={data.servers} />
            ) : null}
          </>
        )}
      </ScrollView>
      {serverForm ? (
        <ServerFormSheet
          client={client}
          target={serverForm}
          groups={data.groups}
          identities={data.identities}
          servers={data.servers}
          onClose={closeSheets}
          onSaved={handleSaved}
        />
      ) : null}
      {groupForm ? (
        <GroupFormSheet
          client={client}
          target={groupForm}
          groups={data.groups}
          identities={data.identities}
          onClose={closeSheets}
          onSaved={handleSaved}
        />
      ) : null}
      {identityForm ? (
        <IdentityFormSheet
          client={client}
          target={identityForm}
          keys={data.keys}
          onClose={closeSheets}
          onSaved={handleSaved}
        />
      ) : null}
      {importOpen ? (
        <ImportServersSheet client={client} onClose={closeSheets} onImported={refresh} />
      ) : null}
      {keySheet ? (
        <KeyFormSheet client={client} mode={keySheet} onClose={closeSheets} onSaved={handleSaved} />
      ) : null}
    </>
  );
}

function ServersHeaderActions({
  onAddGroup,
  onAddServer,
  onImport,
}: {
  onAddGroup: () => void;
  onAddServer: () => void;
  onImport: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Button size="sm" variant="outline" onPress={onImport} testID="servers-import">
        {t("ssh.import.action")}
      </Button>
      <Button
        size="sm"
        variant="outline"
        leftIcon={FolderPlus}
        onPress={onAddGroup}
        testID="servers-add-group"
      >
        Add group
      </Button>
      <Button size="sm" leftIcon={Plus} onPress={onAddServer} testID="servers-add-server">
        Add server
      </Button>
    </>
  );
}
