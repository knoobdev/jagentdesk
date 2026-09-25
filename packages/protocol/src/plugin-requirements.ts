import type { PluginRequirements } from "./messages.js";
import parse from "semver/functions/parse.js";
import validRange from "semver/ranges/valid.js";
import satisfies from "semver/functions/satisfies.js";

export function validatePluginRequirements(requirements: PluginRequirements | undefined): void {
  const range = requirements?.jagentdesk;
  if (range !== undefined && (!range.trim() || validRange(range) === null)) {
    throw new Error(
      `Invalid requirements.jagentdesk: ${JSON.stringify(range)}. Use an npm semver range such as ">=0.8.0".`,
    );
  }
}

interface PluginCompatibilityInput {
  id: string;
  requirements?: PluginRequirements;
  version: string | null;
  runtime: "daemon" | "app";
}

export function assertPluginCompatibility(input: PluginCompatibilityInput): void {
  validatePluginRequirements(input.requirements);
  // Upstream treats a manifest without requirements as "<0.8.0" and rejects it on 0.8+. JAgentDesk
  // keeps loading those pre-split plugins (the runtime runs a single index.ts entry as the client
  // entry), so only an explicitly declared range is enforced.
  const range = input.requirements?.jagentdesk;
  if (range === undefined) return;
  const version = input.version ? parse(input.version) : null;
  if (!version) {
    throw new Error(
      `Cannot check plugin "${input.id}" requirements: JAgentDesk ${input.runtime} version is unknown. Update the ${input.runtime}.`,
    );
  }
  const stableCore = `${version.major}.${version.minor}.${version.patch}`;
  if (satisfies(version, range) || satisfies(stableCore, range)) return;
  throw new Error(
    `Plugin "${input.id}" requires JAgentDesk ${range}. Your ${input.runtime} is ${input.version}. Use a compatible plugin version or update the ${input.runtime}.`,
  );
}
