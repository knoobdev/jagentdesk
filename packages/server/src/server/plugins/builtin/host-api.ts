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
export type {
  BuiltinServerHost,
  BuiltinBackgroundService,
  BuiltinToolContext,
  BuiltinSessionServices,
  BuiltinSessionContribution,
  RegisterBuiltinTool,
} from "./host.js";

// ssh-servers migration
export type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
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
export type { AgentPermissionResponse } from "../../agent/agent-sdk-types.js";
export type { JAgentDeskToolDefinition } from "../../agent/tools/types.js";
export type { AcquireSshClient } from "../../ssh/ssh-client-lease.js";
export {
  listRemoteDir,
  readRemoteFile,
  writeRemoteFile,
} from "../../ssh/environment/remote-files.js";
export { runRemoteCommand } from "../../ssh/environment/remote-exec.js";
export { remoteDockerArgs } from "../../ssh/remote-docker/cockpit.js";
