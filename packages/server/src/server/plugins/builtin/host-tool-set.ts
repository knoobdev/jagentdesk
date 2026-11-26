import type { HostToolSetSource } from "../../agent/host-tool-set.js";
import {
  BROWSER_TOOLS_GROUP_ID,
  buildHostToolInstructions,
  hostToolGroupName,
  type HostToolGroups,
  type HostToolGroupState,
} from "../../agent/tools/host-tool-groups.js";
import { builtinPluginsWithToolPrefixes } from "./gates.js";
import type { BuiltinServerRegistry } from "./host.js";
import type { BuiltinPluginState } from "./state.js";

/**
 * Built-in tool groups as the agent manager and the agent tools see them: only built-ins that
 * give agents tools count, so turning on Insights does not restart anyone's runtime.
 */
export function createBuiltinHostToolSet(input: {
  state: BuiltinPluginState;
  registry: Pick<BuiltinServerRegistry, "agentToolPluginIds">;
}): { source: HostToolSetSource; groups: HostToolGroups } {
  const { state } = input;
  const toolGroupIds = new Set<string>([
    ...input.registry.agentToolPluginIds(),
    ...builtinPluginsWithToolPrefixes(),
  ]);
  const onlyToolGroups = (ids: ReadonlySet<string>) =>
    new Set([...ids].filter((id) => toolGroupIds.has(id)));

  const groups: HostToolGroups = {
    list: (callerAgentId) => {
      const launched = state.forAgent(callerAgentId);
      return state
        .list()
        .filter((entry) => toolGroupIds.has(entry.id))
        .map(
          (entry): HostToolGroupState => ({
            id: entry.id,
            name: hostToolGroupName(entry.id, entry.name),
            launched: launched.has(entry.id),
            on: state.isEnabled(entry.id),
            available: entry.available,
            unavailableReason: entry.unavailableReason,
          }),
        );
    },
    turnOn: async (id) => {
      const entry = state.list().find((candidate) => candidate.id === id);
      if (!entry || !toolGroupIds.has(entry.id)) throw new Error(`Unknown tool group: ${id}`);
      // Cascade: a group that needs another built-in turns that one on too.
      await state.set(entry.id, true, true);
    },
  };

  const source: HostToolSetSource = {
    launched: (agentId) => onlyToolGroups(state.forAgent(agentId)),
    current: () => onlyToolGroups(state.current()),
    adopt: (agentId) => {
      state.adoptForAgent(agentId);
    },
    instructions: (agentId) => buildHostToolInstructions(groups.list(agentId)),
    inAppBrowser: (agentId) => state.forAgent(agentId).has(BROWSER_TOOLS_GROUP_ID),
  };
  return { source, groups };
}
