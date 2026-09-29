import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCli } from "./cli";
import { createCliParseArgv } from "./run";

describe("runCli", () => {
  it("lets plugin update own --version while preserving global output options", async () => {
    const cli = createCli()
      .exitOverride()
      .configureOutput({ writeOut: () => {} });
    const update = cli.commands
      .find((command) => command.name() === "plugin")!
      .commands.find((command) => command.name() === "update")!;
    let received: Record<string, unknown> | undefined;
    update.action((_id, options) => {
      received = options;
    });
    await cli.parseAsync(
      ["plugin", "update", "example", "--version", "1.2.0", "--format", "json", "--no-color"],
      { from: "user" },
    );
    expect(received).toMatchObject({ version: "1.2.0" });
    expect(update.optsWithGlobals()).toMatchObject({ format: "json", color: false });
  });

  it("defaults an empty CLI invocation to onboard", () => {
    expect(
      createCliParseArgv({
        argv: [],
        cwd: process.cwd(),
        nodeArgv: ["node", "jagentdesk"],
      }),
    ).toEqual(["node", "jagentdesk", "onboard"]);
  });

  it("preserves known CLI command argv", () => {
    expect(
      createCliParseArgv({
        argv: ["daemon", "set-password"],
        cwd: process.cwd(),
        nodeArgv: ["node", "jagentdesk"],
      }),
    ).toEqual(["node", "jagentdesk", "daemon", "set-password"]);
  });

  it("preserves the hooks command argv", () => {
    expect(
      createCliParseArgv({
        argv: ["hooks", "claude", "UserPromptSubmit"],
        cwd: process.cwd(),
        nodeArgv: ["node", "jagentdesk"],
      }),
    ).toEqual(["node", "jagentdesk", "hooks", "claude", "UserPromptSubmit"]);
  });

  it("classifies existing unknown directories as open-project invocations", () => {
    const root = mkdtempSync(path.join(tmpdir(), "jagentdesk-cli-run-"));
    const project = path.join(root, "project");
    mkdirSync(project);

    try {
      expect(
        createCliParseArgv({
          argv: ["project"],
          cwd: root,
          nodeArgv: ["node", "jagentdesk"],
        }),
      ).toEqual({
        kind: "open-project",
        resolvedPath: project,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
