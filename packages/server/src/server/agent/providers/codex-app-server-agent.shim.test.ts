import path from "node:path";
import { describe, expect, it } from "vitest";
import { agentShimEnv } from "../../agent-browser-shim/install.js";
import { codexAgentShimOverrides } from "./codex-app-server-agent.js";

describe("codexAgentShimOverrides", () => {
  const dir = path.join(path.sep, "home", "user", ".jagentdesk", "agent-bin");
  const shim = agentShimEnv({ dir, basePath: ["/usr/local/bin", "/usr/bin", "/bin"].join(":") });

  it("re-applies the shim PATH and BROWSER on top of Codex's shell snapshot", () => {
    expect(codexAgentShimOverrides({ PATH: shim.PATH, BROWSER: shim.BROWSER })).toEqual([
      "-c",
      `shell_environment_policy.set.PATH=${JSON.stringify(shim.PATH)}`,
      "-c",
      `shell_environment_policy.set.BROWSER=${JSON.stringify(shim.BROWSER)}`,
    ]);
  });

  it("leaves Codex alone when the agent has no shim", () => {
    expect(codexAgentShimOverrides({ PATH: "/usr/bin:/bin" })).toEqual([]);
    expect(codexAgentShimOverrides({ PATH: "/usr/bin:/bin", BROWSER: "firefox" })).toEqual([]);
    // A BROWSER shim that is not first on PATH was set by someone else; do not pin it.
    expect(
      codexAgentShimOverrides({ PATH: `/usr/bin:${shim.PATH}`, BROWSER: shim.BROWSER }),
    ).toEqual([]);
  });
});
