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
export { FileSecretStore, type SecretStore } from "../../database/secret-store.js";
export { ensurePrivateDirectory, writePrivateFileAtomicSync } from "../../private-files.js";
export type { AgentPermissionResponse } from "../../agent/agent-sdk-types.js";
export type { JAgentDeskToolDefinition } from "../../agent/tools/types.js";
export type { BotTrigger } from "../../bots/service.js";
export type {
  BuiltinAgentToolContext,
  BuiltinBotTriggerContext,
  BuiltinBotTriggerSource,
  BuiltinServiceHandle,
  BuiltinServerHost,
  BuiltinBackgroundService,
  BuiltinSessionServices,
  BuiltinSessionContribution,
  RegisterBuiltinTool,
} from "./host.js";
// forge-hub
export { findExecutable } from "../../../executable-resolution/executable-resolution.js";
export { sharedHostToolInstaller } from "../../host-tools/shared-installer.js";
export { spawn as spawnPty, type IPty as Pty } from "node-pty";
export { getToolDefinition, hostTarget } from "../../host-tools/registry.js";
export { createExternalCommandProcessEnv } from "../../jagentdesk-env.js";
