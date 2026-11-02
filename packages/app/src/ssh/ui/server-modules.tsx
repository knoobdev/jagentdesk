import { useCallback, useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import type { DaemonClient, SshServerInfo } from "@jagentdesk/client/internal/daemon-client";
import type { SftpEndpoint, SftpEntry } from "@jagentdesk/protocol/ssh/sftp-schemas";
import { useFileDownload } from "@/hooks/use-file-download";
import type { SshModuleTransport } from "@/ssh/module-rpc";
import { createForwardingApi, type ForwardingApi } from "@/ssh/forwarding/api";
import { PortForwardingList } from "@/ssh/forwarding/forwarding-list";
import { createSftpApi, type SftpApi } from "@/ssh/sftp/api";
import { SftpBrowser, type SftpDeviceDownloadReady } from "@/ssh/sftp/sftp-browser";
import { SftpFileEditor } from "@/ssh/sftp/sftp-file-editor";
import { ErrorBanner } from "./primitives";
import { sshStyles as styles } from "./styles";

// Mounts the S2 (SFTP) and S3 (port forwarding) modules in the Servers UI (spec 25.13):
// a server's SFTP and Forwarding sections next to its terminal, and the Port forwarding tab.

export interface SshModuleApis {
  sftp: SftpApi;
  forwarding: ForwardingApi;
}

/** One transport per daemon client, built on DaemonClient's generic module request. */
export function useSshModuleApis(client: DaemonClient | null): SshModuleApis | null {
  return useMemo(() => {
    if (!client) return null;
    const transport: SshModuleTransport = {
      request: (message) =>
        client.sshModuleRequest(message as { type: `ssh.${string}.request` } & typeof message),
      subscribe: (type, handler) => client.onSshModulePush(type, handler),
    };
    return { sftp: createSftpApi(transport), forwarding: createForwardingApi(transport) };
  }, [client]);
}

function useServerChoices(servers: SshServerInfo[]) {
  return useMemo(
    () => servers.map((server) => ({ serverId: server.id, label: server.label })),
    [servers],
  );
}

/** Starts the device download of a file the SFTP browser staged on the daemon. */
function DeviceDownload({
  hostServerId,
  download,
  onDone,
}: {
  hostServerId: string;
  download: SftpDeviceDownloadReady;
  onDone: () => void;
}) {
  const start = useFileDownload({ serverId: hostServerId, workspaceRoot: download.cwd });
  useEffect(() => {
    start({ fileName: download.fileName, path: download.path });
    onDone();
  }, [download, onDone, start]);
  return null;
}

interface OpenFile {
  endpoint: SftpEndpoint;
  path: string;
}

function endpointLabelFor(endpoint: SftpEndpoint | undefined, servers: SshServerInfo[]): string {
  if (!endpoint || endpoint.kind === "daemon") return "This daemon";
  return servers.find((candidate) => candidate.id === endpoint.serverId)?.label ?? "Server";
}

export function ServerSftpSection({
  apis,
  hostServerId,
  server,
  servers,
}: {
  apis: SshModuleApis;
  hostServerId: string;
  server: SshServerInfo;
  servers: SshServerInfo[];
}) {
  const choices = useServerChoices(servers);
  const [openFile, setOpenFile] = useState<OpenFile | null>(null);
  const [download, setDownload] = useState<SftpDeviceDownloadReady | null>(null);
  const initialLeft = useMemo<SftpEndpoint>(() => ({ kind: "daemon" }), []);
  const initialRight = useMemo<SftpEndpoint>(
    () => ({ kind: "server", serverId: server.id }),
    [server.id],
  );
  const handleOpenFile = useCallback(
    (endpoint: SftpEndpoint, entry: SftpEntry) => setOpenFile({ endpoint, path: entry.path }),
    [],
  );
  const closeEditor = useCallback(() => setOpenFile(null), []);
  const clearDownload = useCallback(() => setDownload(null), []);
  const endpointLabel = endpointLabelFor(openFile?.endpoint, servers);
  return (
    <View style={styles.terminalBody} testID="ssh-server-sftp">
      {openFile ? (
        <SftpFileEditor
          api={apis.sftp}
          scope={hostServerId}
          endpoint={openFile.endpoint}
          endpointLabel={endpointLabel}
          path={openFile.path}
          onClose={closeEditor}
        />
      ) : (
        <SftpBrowser
          api={apis.sftp}
          scope={hostServerId}
          servers={choices}
          daemonLabel="This daemon"
          initialLeft={initialLeft}
          initialRight={initialRight}
          onOpenFile={handleOpenFile}
          onDeviceDownloadReady={setDownload}
        />
      )}
      {download ? (
        <DeviceDownload hostServerId={hostServerId} download={download} onDone={clearDownload} />
      ) : null}
    </View>
  );
}

/** Forwarding rules: one server's (with "open on connect") or all of them. */
export function ForwardingSection({
  apis,
  client,
  servers,
  server,
  onServerSaved,
}: {
  apis: SshModuleApis;
  client: DaemonClient | null;
  servers: SshServerInfo[];
  server?: SshServerInfo;
  onServerSaved?: () => void;
}) {
  const choices = useServerChoices(servers);
  const [error, setError] = useState<string | null>(null);
  // "Open on connect" edits the server's forwardingRuleIds (spec 25.2 / 25.6).
  const handleAutoStartChange = useCallback(
    (ruleId: string, enabled: boolean) => {
      if (!client || !server) return;
      const current = server.forwardingRuleIds ?? [];
      const next = enabled
        ? Array.from(new Set([...current, ruleId]))
        : current.filter((id) => id !== ruleId);
      const { state: _state, lastError: _lastError, hasPassword: _hasPassword, ...rest } = server;
      void (async () => {
        try {
          const res = await client.sshServersSave({ server: { ...rest, forwardingRuleIds: next } });
          setError(res.error);
          if (!res.error) onServerSaved?.();
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : "Could not update the server");
        }
      })();
    },
    [client, onServerSaved, server],
  );
  return (
    <View style={styles.forwardingSection} testID="ssh-forwarding-section">
      {error ? <ErrorBanner message={error} /> : null}
      <PortForwardingList
        api={apis.forwarding}
        servers={choices}
        serverId={server?.id}
        autoStartRuleIds={server ? (server.forwardingRuleIds ?? []) : undefined}
        onAutoStartChange={server ? handleAutoStartChange : undefined}
      />
    </View>
  );
}
