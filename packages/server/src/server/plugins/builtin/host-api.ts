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
export type {
  BuiltinServerHost,
  BuiltinBackgroundService,
  BuiltinSessionServices,
  BuiltinSessionContribution,
  RegisterBuiltinTool,
  BuiltinToolContext,
  BuiltinRpcOptions,
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
