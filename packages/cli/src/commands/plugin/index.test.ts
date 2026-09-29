import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PluginUpdatePreview,
  PluginUpdateProposal,
  PluginUpdateResult,
} from "@jagentdesk/protocol/messages";

const host = "127.0.0.1:12345";

const listPlugins = vi.fn(async () => [
  {
    id: "git-plugin",
    path: "/plugins/git-plugin",
    enabled: true,
    status: "running" as const,
    installation: {
      identity: {
        kind: "git" as const,
        remote: "https://git.invalid/plugin.git",
        pluginPath: ".",
      },
      currentRevision: "1557a34c91e2abcdef",
    },
  },
  {
    id: "directory-plugin",
    path: "/plugins/directory-plugin",
    enabled: true,
    status: "failed" as const,
    error: "Plugin entry points are missing",
  },
]);
const installSourcePlugin = vi.fn(async () => ({
  id: "trusted-plugin",
  path: "/plugins/trusted-plugin",
  enabled: true,
  status: "running" as const,
}));
const installDirectoryPlugin = vi.fn(async () => ({
  id: "trusted-plugin",
  path: "/plugins/trusted-plugin",
  enabled: true,
  status: "running" as const,
}));
const previewPluginUpdates = vi.fn(async (): Promise<PluginUpdatePreview[]> => []);
const close = vi.fn(async () => undefined);
const features: {
  pluginManagement?: boolean;
  pluginSourceInstallation?: boolean;
  pluginSourceUpdates?: boolean;
} = {};

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({
    getLastServerInfoMessage: () => ({ features }),
    listPlugins,
    installDirectoryPlugin,
    installSourcePlugin,
    previewPluginUpdates,
    close,
  })),
}));

import { render } from "../../output/index.js";
import {
  createPluginCommand,
  runPluginInstallCommand,
  runPluginListCommand,
  runPluginUpdateCommand,
} from "./index.js";
import { reviewPluginUpdates, type UpdateInteraction } from "./update.js";

describe("plugin management commands", () => {
  beforeEach(() => {
    features.pluginManagement = false;
    features.pluginSourceInstallation = false;
    features.pluginSourceUpdates = false;
    vi.clearAllMocks();
  });

  it("keeps status as a hidden alias for the plugin list", async () => {
    features.pluginManagement = true;
    const command = createPluginCommand();

    await command.parseAsync(["status"], { from: "user" });

    expect(listPlugins).toHaveBeenCalledTimes(1);
    expect(command.helpInformation()).not.toContain("status");
  });

  it("lists the installed source and revision", async () => {
    features.pluginManagement = true;

    const result = await runPluginListCommand(undefined, { host }, {} as never);
    const output = render(result, { noColor: true });

    expect(output).toContain("SOURCE");
    expect(output).toContain("REVISION");
    expect(output).toContain("git:https://git.invalid/plugin.git");
    expect(output).toContain("1557a34c91e2");
  });

  it("filters the shared ls and status command by plugin ID", async () => {
    features.pluginManagement = true;

    const result = await runPluginListCommand("directory-plugin", { host }, {} as never);

    expect(result.data.map((plugin) => plugin.id)).toEqual(["directory-plugin"]);
  });

  it("prints the trust acknowledgement before installing", async () => {
    features.pluginSourceInstallation = true;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const command = createPluginCommand();

    await command.parseAsync(["install", "/plugins/trusted-plugin"], { from: "user" });

    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("preparation commands run unsandboxed on the daemon host"),
    );
    expect(installSourcePlugin).toHaveBeenCalledWith("/plugins/trusted-plugin", {});
    stderr.mockRestore();
  });

  it("requires source support for directory installs without using the legacy RPC", async () => {
    features.pluginManagement = true;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(
      runPluginInstallCommand("/plugins/trusted-plugin", { host }, {} as never),
    ).rejects.toMatchObject({
      code: "DAEMON_UPDATE_REQUIRED",
      message: "Update the host to install plugin sources.",
    });
    expect(installSourcePlugin).not.toHaveBeenCalled();
    expect(installDirectoryPlugin).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    stderr.mockRestore();
  });

  it("installs npm sources with an explicit ID and Git ref passthrough", async () => {
    features.pluginSourceInstallation = true;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runPluginInstallCommand(
      "npm:example-plugin@^1.0.0",
      { host, id: "example" },
      {} as never,
    );
    await runPluginInstallCommand("owner/repository", { host, ref: "v1" }, {} as never);

    expect(installSourcePlugin).toHaveBeenNthCalledWith(1, "npm:example-plugin@^1.0.0", {
      id: "example",
    });
    expect(installSourcePlugin).toHaveBeenNthCalledWith(2, "owner/repository", { ref: "v1" });
    stderr.mockRestore();
  });

  it("folds the legacy --path option into the plugin source reference", async () => {
    features.pluginSourceInstallation = true;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const command = createPluginCommand();

    await command.parseAsync(["install", "owner/monorepo", "--path", "plugins/review"], {
      from: "user",
    });

    expect(installSourcePlugin).toHaveBeenCalledWith("owner/monorepo:plugins/review", {});
    stderr.mockRestore();
  });

  it("reviews updates when the host supports reviewed updates", async () => {
    features.pluginSourceUpdates = true;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runPluginUpdateCommand("example", { host }, {} as never);

    expect(previewPluginUpdates).toHaveBeenCalledWith({ pluginId: "example", target: undefined });
    expect(close).toHaveBeenCalledTimes(1);
    stderr.mockRestore();
  });

  it("rejects reviewed updates before an RPC on an older host", async () => {
    features.pluginManagement = true;
    features.pluginSourceInstallation = true;

    await expect(runPluginUpdateCommand("example", { host }, {} as never)).rejects.toMatchObject({
      code: "DAEMON_UPDATE_REQUIRED",
      message: "Update the host to review plugin updates.",
    });
    expect(previewPluginUpdates).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

function reviewFixture(answer = true, outcome: "update" | "installed-newer" = "update") {
  const proposal: PluginUpdateProposal = {
    id: "example",
    expected: {
      identity: { kind: "npm", packageName: "example-plugin", pluginPath: "." },
      installationRoot: "/owned/one",
      revision: "1.0.0",
    },
    target: {
      kind: "npm",
      version: "1.1.0",
      resolved: "https://registry.npmjs.org/example-plugin/-/example-plugin-1.1.0.tgz",
      integrity: "sha512-test",
    },
  };
  const preview: PluginUpdatePreview = {
    id: "example",
    outcome,
    links: ["https://www.npmjs.com/package/example-plugin/v/1.1.0"],
    current: { identity: proposal.expected.identity, currentRevision: "1.0.0" },
    target: proposal.target,
    ...(outcome === "update" ? { proposal } : {}),
  };
  const applied: PluginUpdateProposal[][] = [];
  const questions: string[] = [];
  const output: string[] = [];
  const client = {
    previewPluginUpdates: async () => [preview],
    applyPluginUpdates: async (
      proposals: PluginUpdateProposal[],
    ): Promise<PluginUpdateResult[]> => {
      applied.push(proposals);
      return [{ id: "example", outcome: "updated" }];
    },
  };
  const interaction: UpdateInteraction = {
    interactive: true,
    structured: false,
    write: (text) => {
      output.push(text);
    },
    confirm: async (question) => {
      questions.push(question);
      return answer;
    },
  };
  return { client, interaction, proposal, applied, questions, output };
}

describe("reviewed plugin update workflow", () => {
  it("prints target and links, then declines without applying", async () => {
    const f = reviewFixture(false);
    expect(await reviewPluginUpdates(f.client, { pluginId: "example" }, f.interaction)).toEqual([
      { id: "example", outcome: "declined" },
    ]);
    expect(f.output.join("")).toContain("1.0.0 → 1.1.0");
    expect(f.output.join("")).toContain("Review: https://");
    expect(f.questions).toEqual(["Update example? [y/N] "]);
    expect(f.applied).toEqual([]);
  });

  it("applies exactly the displayed proposal after approval", async () => {
    const f = reviewFixture();
    await reviewPluginUpdates(f.client, { pluginId: "example" }, f.interaction);
    expect(f.applied).toEqual([[f.proposal]]);
  });

  it.each([{ yes: true }, { version: "stable" }, { ref: "v1" }])(
    "skips questions for %j",
    async (options) => {
      const f = reviewFixture();
      await reviewPluginUpdates(f.client, { pluginId: "example", ...options }, f.interaction);
      expect(f.questions).toEqual([]);
      expect(f.applied).toEqual([[f.proposal]]);
    },
  );

  it("check takes precedence over yes and explicit targets", async () => {
    const f = reviewFixture();
    await reviewPluginUpdates(
      f.client,
      { pluginId: "example", check: true, yes: true, version: "1.1.0" },
      f.interaction,
    );
    expect(f.applied).toEqual([]);
    expect(f.questions).toEqual([]);
  });

  it("yes never applies an ordinary downgrade", async () => {
    const f = reviewFixture(true, "installed-newer");
    await reviewPluginUpdates(f.client, { all: true, yes: true }, f.interaction);
    expect(f.applied).toEqual([]);
    expect(f.questions).toEqual([]);
  });

  it.each([{ interactive: false }, { structured: true }])(
    "requires explicit approval for %j",
    async (flags) => {
      const f = reviewFixture();
      await expect(
        reviewPluginUpdates(f.client, { pluginId: "example" }, { ...f.interaction, ...flags }),
      ).rejects.toThrow("Confirmation required");
      expect(f.applied).toEqual([]);
    },
  );

  it("rejects ambiguous selections before contacting the host", async () => {
    const f = reviewFixture();
    await expect(reviewPluginUpdates(f.client, {}, f.interaction)).rejects.toThrow(
      "Choose one plugin ID or pass --all",
    );
    await expect(
      reviewPluginUpdates(
        f.client,
        { pluginId: "example", ref: "v1", version: "1" },
        f.interaction,
      ),
    ).rejects.toThrow("Choose --ref or --version, not both");
  });
});
