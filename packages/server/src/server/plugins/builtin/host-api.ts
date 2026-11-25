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
  BuiltinDaemonContext,
  BuiltinDaemonRef,
  BuiltinDaemonScope,
  BuiltinRequestContext,
  BuiltinSessionServices,
  BuiltinSessionContribution,
  BuiltinToolContext,
  RegisterBuiltinTool,
} from "./host.js";

export { ensureValidJson } from "../../json-utils.js";
export { writeFileAtomic, writeJsonFileAtomic } from "../../atomic-file.js";
export { sendPromptToAgent } from "../../agent/agent-prompt.js";
export type { AgentManager, AgentManagerEvent, ManagedAgent } from "../../agent/agent-manager.js";
export type { HostCapabilityService } from "../../host-capabilities/service.js";
export type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";

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

// Spec mode provides the plan; the activity graph reads it.
export {
  NO_SPEC_PLAN_SOURCE,
  parseSpecKitTasks,
  type SpecPlan,
  type SpecPlanSource,
  type SpecPlanStatus,
} from "../../agent/spec-plan.js";

// The activity graph reads agent timelines and renders with the vendored archify (core).
export type {
  AgentPermissionRequest,
  AgentTaskItem,
  AgentUsage,
  AgentTimelineItem,
  ToolCallTimelineItem,
} from "../../agent/agent-sdk-types.js";
export type { AgentTimelineRow } from "../../agent/agent-timeline-store-types.js";
export type { ProviderSubagentDescriptor } from "../../agent/provider-subagents/store.js";
export { ensureUnarchivedAgentLoaded } from "../../agent/agent-loading.js";
export { runArchifyRenderer, type ArchifyDiagramError } from "../../archify/archify-renderer.js";
