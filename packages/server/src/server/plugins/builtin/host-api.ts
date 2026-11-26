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
export { FileSecretStore, type SecretStore } from "../../database/secret-store.js";
export { ensurePrivateDirectory, writePrivateFileAtomicSync } from "../../private-files.js";
export type { AgentPermissionResponse } from "../../agent/agent-sdk-types.js";
export type { JAgentDeskToolDefinition } from "../../agent/tools/types.js";
export type { BotTrigger } from "../../bots/service.js";
export { staticHostSupport, type StaticHostSupport } from "../../host-capabilities/service.js";

export type {
  BuiltinDaemonSlot,
  BuiltinAgentToolContext,
  BuiltinBotTriggerContext,
  BuiltinBotTriggerSource,
  BuiltinProvidedServices,
  BuiltinServiceHandle,
  BuiltinServerHost,
  BuiltinBackgroundService,
  BuiltinToolContext,
  BuiltinDaemonContext,
  BuiltinDaemonRef,
  BuiltinDaemonScope,
  BuiltinRequestContext,
  BuiltinPorts,
  BuiltinPortKey,
  BuiltinProject,
  BuiltinProjectAccess,
  BuiltinDaemonDeps,
  BuiltinToolSelection,
  BuiltinSessionServices,
  BuiltinSessionContribution,
  BrowserFingerprintProfileStore,
  RegisterBuiltinTool,
  BuiltinRpcOptions,
} from "./host.js";
export type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
export type { ClusterRegistry } from "../../cluster/cluster-registry.js";
export { detectKubeContexts } from "../../cluster/kube-config-source.js";
export { GENERIC_KINDS } from "../../cluster/kube-client.js";
export type { DatabaseRegistry } from "../../database/database-registry.js";
export type { DatabaseEngine } from "../../database/database-dto.js";
export { localPortOfTarget } from "../../ssh/remote-db/service.js";

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
// forge-hub
export { findExecutable } from "../../../executable-resolution/executable-resolution.js";
export { sharedHostToolInstaller } from "../../host-tools/shared-installer.js";
export { spawn as spawnPty, type IPty as Pty } from "node-pty";
export { getToolDefinition, hostTarget } from "../../host-tools/registry.js";
export { createExternalCommandProcessEnv } from "../../jagentdesk-env.js";
// devices
export { writeJsonFileAtomic } from "../../atomic-file.js";
export { androidSdkCandidates } from "../../host-capabilities/service.js";
export { toolsBinDir } from "../../host-tools/installer.js";
export { vendorDirectoryCandidates } from "../../vendor-directory.js";
// workbench
export { resolveJAgentDeskHome } from "../../jagentdesk-home.js";

export { ensureValidJson } from "../../json-utils.js";
export { sendPromptToAgent } from "../../agent/agent-prompt.js";
export type { AgentManager, AgentManagerEvent, ManagedAgent } from "../../agent/agent-manager.js";
export type { HostCapabilityService } from "../../host-capabilities/service.js";

// Shared by skills, spec mode, and host tools.
export {
  DEFAULT_LIMITS,
  safeTarget,
  extractTarGz,
  type ExtractLimits,
} from "../../../utils/tar.js";
export { resolveBundledSkillsDir } from "../../agent/bundled-skills.js";
export {
  buildSkillId,
  INSTALL_LINK_DIRS,
  INSTALL_REAL_DIR,
  isWithin,
  parseSkillId,
  skillDirPath,
  SKILL_DIR_SPECS,
  visibleToFor,
  type SkillDirLabel,
} from "../../agent/native-skill-paths.js";

export type {
  DurableContextSettings,
  MemoryPort,
  MemoryTurnInjection,
} from "../../agent/memory-port.js";
// Autorun reads turn usage; Session sharing reads agent timelines.
export type { AgentTimelineItem, AgentUsage } from "../../agent/agent-sdk-types.js";

// Session sharing: core owns guest confinement and the tunnel binary; the feature owns shares.
export { guestScopesForCapabilities } from "../../authorization/guest-scopes.js";
export { TunnelManager, CloudflaredMissingError } from "../../tunnels/tunnel-manager.js";
export type { AgentStorage } from "../../agent/agent-storage.js";

// The agentic browser's tools drive the core browser broker (basic browser tools stay core).
export type { BrowserToolsBroker } from "../../browser-tools/broker.js";
export type { BrowserHostTarget, BrowserToolsResponsePayload } from "../../browser-tools/errors.js";
export { expandUserPath } from "../../path-utils.js";
export { JAgentDeskToolInputError } from "../../agent/tools/types.js";
