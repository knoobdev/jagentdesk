/** The only daemon implementation entry point available to statically linked feature plugins. */
export { DockerService, parseStatsLine, type DockerSnapshot } from "../../docker/docker-service.js";
export { DockerStreams } from "../../docker/docker-streams.js";
export {
  routeDockerMessage,
  disposeRemoteDocker,
  type RoutedDocker,
  type DockerBackend,
} from "../../ssh/remote-docker/route.js";
export { RemoteDockerError, type RemoteDockerHosts } from "../../ssh/remote-docker/hosts.js";
export { execCommand, spawnProcess } from "../../../utils/spawn.js";
export type {
  JAgentDeskToolConfig,
  JAgentDeskToolExecutionContext,
  JAgentDeskToolResult,
} from "../../agent/tools/types.js";
export type { BuiltinCoreServices, BuiltinPlatformServices } from "./services.js";
export { createDaemonSlot } from "./host.js";
export type {
  BuiltinDaemonSlot,
  BuiltinServerHost,
  BuiltinBackgroundService,
  BuiltinToolContext,
  BuiltinSessionServices,
  BuiltinSessionContribution,
  RegisterBuiltinTool,
  BuiltinRpcOptions,
  BuiltinToolSelection,
} from "./host.js";
export type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
export type { ClusterRegistry } from "../../cluster/cluster-registry.js";
export { detectKubeContexts } from "../../cluster/kube-config-source.js";
export { GENERIC_KINDS } from "../../cluster/kube-client.js";
export type { DatabaseRegistry } from "../../database/database-registry.js";
export type { DatabaseEngine } from "../../database/database-dto.js";
export { localPortOfTarget } from "../../ssh/remote-db/service.js";
export { FileSecretStore } from "../../database/secret-store.js";
export type { SecretStore } from "../../database/secret-store.js";
export type { AgentPermissionResponse } from "../../agent/agent-sdk-types.js";
export type { JAgentDeskToolDefinition } from "../../agent/tools/types.js";
export { ensurePrivateDirectory, writePrivateFileAtomicSync } from "../../private-files.js";

// ssh-servers migration
export type { SshModuleRpcHandler, SshService } from "../../ssh/ssh-service.js";
export { EnvironmentDetectError } from "../../ssh/environment/service.js";
export type { SshEnvironmentService } from "../../ssh/environment/service.js";
export { ForwardingError } from "../../ssh/forwarding/rule-store.js";
export type { ForwardingService } from "../../ssh/forwarding/service.js";
export type { SshImporter } from "../../ssh/logs-import/importer.js";
export type { KeyInstallService } from "../../ssh/logs-import/install-key.js";
export type { SessionLogService } from "../../ssh/logs-import/session-log.js";
export { RemoteDbError } from "../../ssh/remote-db/service.js";
export type { RemoteDbTunnels } from "../../ssh/remote-db/service.js";
export { RemoteK8sError } from "../../ssh/remote-k8s/service.js";
export type { RemoteK8sClusters } from "../../ssh/remote-k8s/service.js";
export { SftpError } from "../../ssh/sftp/file-system.js";
export type { SftpService } from "../../ssh/sftp/service.js";
export type { SshSnippetsService } from "../../ssh/snippets/service.js";
export type { TelnetService } from "../../ssh/telnet/service.js";
export type { AcquireSshClient } from "../../ssh/ssh-client-lease.js";
export {
  listRemoteDir,
  readRemoteFile,
  writeRemoteFile,
} from "../../ssh/environment/remote-files.js";
export { runRemoteCommand } from "../../ssh/environment/remote-exec.js";
export { remoteDockerArgs } from "../../ssh/remote-docker/cockpit.js";

// remote-tasks migration
export {
  ensureSecureDir,
  writeSecureFileAtomic,
  WriteQueue,
} from "../../ssh/snippets/secure-file.js";
export { writeFileAtomic } from "../../atomic-file.js";
export { SshConnectionError } from "../../ssh/ssh-connection.js";

// custom-providers migration
export { CustomProviderError } from "../../custom-providers/types.js";
export type {
  CustomProviderService,
  ApiProtocol,
  ApiProviderModel,
  ApiProviderRecord,
  ApiRoute,
  SaveApiProviderInput,
} from "../../custom-providers/types.js";
