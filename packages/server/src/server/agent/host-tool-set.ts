/**
 * The host-configured part of an agent's tool set: built-in features that give agents tools
 * (browser tools and the other built-ins in spec 36). Spec 04 §27b.1, ADR-0057 §5.
 *
 * A provider reads its tool list once, when its runtime starts. A built-in turned on or off
 * later only reaches a running agent when the daemon restarts that runtime on the same native
 * session, so the manager compares the set the runtime was opened with against the host's
 * current set at the start of every turn.
 */
export interface HostToolSetSource {
  /** Tool groups the agent's runtime was opened with. */
  launched(agentId: string): ReadonlySet<string>;
  /** Tool groups the host has on right now. */
  current(): ReadonlySet<string>;
  /** Make the agent's next launch use the host's current tool groups. */
  adopt(agentId: string): void;
  /** System instructions for a launch, built from the adopted tool groups. */
  instructions(agentId: string): string[];
  /** The adopted tool groups include the JAgentDesk in-app browser. */
  inAppBrowser(agentId: string): boolean;
  /** Provider-owned connector families the adopted tool groups replace (spec 29.4). */
  replacedProviderConnectors?(agentId: string): string[];
}

export interface HostToolSetDiff {
  added: string[];
  removed: string[];
}

export function diffHostToolSets(
  launched: ReadonlySet<string>,
  current: ReadonlySet<string>,
): HostToolSetDiff | null {
  const added = [...current].filter((id) => !launched.has(id)).sort();
  const removed = [...launched].filter((id) => !current.has(id)).sort();
  return added.length || removed.length ? { added, removed } : null;
}

export function hostToolSetSignature(diff: HostToolSetDiff): string {
  return `+${diff.added.join(",")} -${diff.removed.join(",")}`;
}
