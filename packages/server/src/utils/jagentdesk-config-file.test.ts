import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { writeFile, truncate, rm } from "node:fs/promises";
import { measureMainThreadWork } from "../test-utils/main-thread-work.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPlatform } from "../test-utils/platform.js";
import {
  readJAgentDeskConfig,
  JAgentDeskConfigSchema,
  JAgentDeskConfigRawSchema,
  getWorktreeSetupCommands,
  getWorktreeTeardownCommands,
} from "./worktree.js";
import {
  readJAgentDeskConfigForEdit,
  statJAgentDeskConfigPath,
  writeJAgentDeskConfigForEdit,
} from "./jagentdesk-config-file.js";

describe("jagentdesk config file substrate", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "jagentdesk-config-file-test-")));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("rejects an oversized config before parsing its otherwise valid JSON", async () => {
    writeFileSync(
      join(tempDir, "jagentdesk.json"),
      JSON.stringify({ extra: "x".repeat(2 * 1024 * 1024) }),
    );
    expect(await readJAgentDeskConfigForEdit(tempDir)).toEqual({
      ok: false,
      error: { code: "invalid_project_config" },
    });
  });

  it("rejects a sparse oversized file without allocating its contents", async () => {
    const configPath = join(tempDir, "jagentdesk.json");
    await writeFile(configPath, "");
    await truncate(configPath, 1024 * 1024 * 1024);
    expect(await readJAgentDeskConfigForEdit(tempDir)).toEqual({
      ok: false,
      error: { code: "invalid_project_config" },
    });
  });

  it.skipIf(isPlatform("win32"))("rejects a FIFO without waiting for a writer", async () => {
    await promisify(execFile)("mkfifo", [join(tempDir, "jagentdesk.json")]);
    const modulePath = fileURLToPath(new URL("./jagentdesk-config-file.ts", import.meta.url));
    const script = `import { readJAgentDeskConfigForEdit } from ${JSON.stringify(modulePath)};
      const result = await readJAgentDeskConfigForEdit(${JSON.stringify(tempDir)});
      if (JSON.stringify(result) !== JSON.stringify({ok:false,error:{code:"invalid_project_config"}})) process.exit(1);`;
    // Isolate the regression: the old sync reader blocks on the pipe and must be killed.
    await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { timeout: 2_000 },
    );
  });

  it("keeps the longest loop stall below 20ms while admitting large configs", async () => {
    const config = {
      scripts: Object.fromEntries(
        Array.from({ length: 7_000 }, (_, i) => [`script${i}`, { command: "echo hi" }]),
      ),
      worktree: { setup: "npm ci" },
    };
    await writeFile(join(tempDir, "jagentdesk.json"), JSON.stringify(config));
    const measured = await measureMainThreadWork("project config 7,000 scripts", () =>
      readJAgentDeskConfigForEdit(tempDir),
    );
    expect(measured.blockingMs).toBeLessThan(20);
    expect(measured.result).toEqual({
      ok: true,
      config,
      revision: await statJAgentDeskConfigPath(tempDir),
    });
  });

  it("rejects a 32MiB config with a loop stall below 20ms", async () => {
    await writeFile(
      join(tempDir, "jagentdesk.json"),
      JSON.stringify({ extra: "x".repeat(32 * 1024 * 1024) }),
    );
    const measured = await measureMainThreadWork("project config 32MiB", () =>
      readJAgentDeskConfigForEdit(tempDir),
    );
    expect(measured.blockingMs).toBeLessThan(20);
    expect(measured.result).toEqual({ ok: false, error: { code: "invalid_project_config" } });
  });

  it.each([
    {
      scripts: Object.fromEntries(
        Array.from({ length: 130 }, (_, i) => [
          `script${i}`,
          { command: "echo hi", extra: { keep: true } },
        ]),
      ),
    },
    {
      scripts: { valid: { command: "echo hi" }, invalid: 42 },
      worktree: { setup: ["one", "", 42] },
    },
    { scripts: ["invalid record"], worktree: { setup: "echo hi" } },
    JSON.parse(
      '{"scripts":{"__proto__":{"command":"echo hi"},"constructor":{"command":"echo hi"}}}',
    ),
  ])("preserves edit and runtime schema behavior with grouped validation (%#)", async (config) => {
    await writeFile(join(tempDir, "jagentdesk.json"), JSON.stringify(config));
    const expected = JAgentDeskConfigRawSchema.safeParse(config);
    expect(await readJAgentDeskConfigForEdit(tempDir)).toEqual(
      expected.success
        ? { ok: true, config: expected.data, revision: await statJAgentDeskConfigPath(tempDir) }
        : { ok: false, error: { code: "invalid_project_config" } },
    );
    expect(await readJAgentDeskConfig(tempDir)).toEqual({
      ok: true,
      config: JAgentDeskConfigSchema.parse(config),
    });
  });

  it("refreshes snapshots after an external edit, repair, and removal", async () => {
    const configPath = join(tempDir, "jagentdesk.json");
    await writeFile(configPath, JSON.stringify({ worktree: { setup: "old" } }));
    const original = await readJAgentDeskConfig(tempDir);
    expect(original).toEqual({ ok: true, config: { worktree: { setup: ["old"], teardown: [] } } });
    await writeFile(configPath, "{ malformed");
    expect(await readJAgentDeskConfigForEdit(tempDir)).toEqual({
      ok: false,
      error: { code: "invalid_project_config" },
    });
    await writeFile(configPath, JSON.stringify({ worktree: { setup: "repaired" } }));
    expect(await readJAgentDeskConfig(tempDir)).toEqual({
      ok: true,
      config: { worktree: { setup: ["repaired"], teardown: [] } },
    });
    await rm(configPath);
    expect(await readJAgentDeskConfigForEdit(tempDir)).toEqual({
      ok: true,
      config: null,
      revision: null,
    });
  });

  it("serializes competing edits so exactly one matching revision commits", async () => {
    const results = await Promise.all(
      ["first", "second"].map((setup) =>
        writeJAgentDeskConfigForEdit({
          repoRoot: tempDir,
          config: { worktree: { setup } },
          expectedRevision: null,
        }),
      ),
    );
    const saved = await readJAgentDeskConfigForEdit(tempDir);
    expect(results[0]).toEqual(saved);
    expect(results[1]).toEqual({
      ok: false,
      error: {
        code: "stale_project_config",
        currentRevision: await statJAgentDeskConfigPath(tempDir),
      },
    });
  });

  it("returns null config and revision when jagentdesk.json is missing", async () => {
    const result = await readJAgentDeskConfigForEdit(tempDir);

    expect(result).toEqual({ ok: true, config: null, revision: null });
  });

  it("returns invalid_project_config for invalid JSON", async () => {
    writeFileSync(join(tempDir, "jagentdesk.json"), "{ invalid json\n");

    const result = await readJAgentDeskConfigForEdit(tempDir);

    expect(result).toEqual({
      ok: false,
      error: { code: "invalid_project_config" },
    });
  });

  it("preserves raw lifecycle string and array forms with a revision token", async () => {
    writeFileSync(
      join(tempDir, "jagentdesk.json"),
      JSON.stringify({
        worktree: {
          setup: "npm install",
          teardown: ["npm run clean", "npm run reset"],
        },
      }),
    );

    const result = await readJAgentDeskConfigForEdit(tempDir);

    expect(result).toEqual({
      ok: true,
      config: {
        worktree: {
          setup: "npm install",
          teardown: ["npm run clean", "npm run reset"],
        },
      },
      revision: await statJAgentDeskConfigPath(tempDir),
    });
  });

  it("keeps runtime lifecycle commands normalized for execution", async () => {
    writeFileSync(
      join(tempDir, "jagentdesk.json"),
      JSON.stringify({
        worktree: {
          setup: "npm install",
          teardown: ["npm run clean", "", 42, "npm run reset"],
        },
      }),
    );

    expect(await getWorktreeSetupCommands(tempDir)).toEqual(["npm install"]);
    expect(await getWorktreeTeardownCommands(tempDir)).toEqual(["npm run clean", "npm run reset"]);
  });

  it("writes pretty JSON with a trailing newline when revision matches", async () => {
    writeFileSync(join(tempDir, "jagentdesk.json"), JSON.stringify({ worktree: { setup: "old" } }));
    const expectedRevision = await statJAgentDeskConfigPath(tempDir);

    const result = await writeJAgentDeskConfigForEdit({
      repoRoot: tempDir,
      config: { worktree: { setup: "npm install" } },
      expectedRevision,
    });

    expect(result).toEqual({
      ok: true,
      config: { worktree: { setup: "npm install" } },
      revision: await statJAgentDeskConfigPath(tempDir),
    });
    expect(readFileSync(join(tempDir, "jagentdesk.json"), "utf8")).toBe(
      '{\n  "worktree": {\n    "setup": "npm install"\n  }\n}\n',
    );
  });

  // POSIX-only: Windows mtime granularity can collapse the two revisions in this fixture.
  it.skipIf(isPlatform("win32"))(
    "rejects stale writes when the current revision changed before rename",
    async () => {
      writeFileSync(
        join(tempDir, "jagentdesk.json"),
        JSON.stringify({ worktree: { setup: "old" } }),
      );
      const expectedRevision = await statJAgentDeskConfigPath(tempDir);
      writeFileSync(
        join(tempDir, "jagentdesk.json"),
        JSON.stringify({ worktree: { setup: "new" } }),
      );
      const currentRevision = await statJAgentDeskConfigPath(tempDir);

      const result = await writeJAgentDeskConfigForEdit({
        repoRoot: tempDir,
        config: { worktree: { setup: "from editor" } },
        expectedRevision,
      });

      expect(result).toEqual({
        ok: false,
        error: { code: "stale_project_config", currentRevision },
      });
      expect(readFileSync(join(tempDir, "jagentdesk.json"), "utf8")).toBe(
        JSON.stringify({ worktree: { setup: "new" } }),
      );
    },
  );

  it("round-trips unknown top-level, worktree, and script-entry fields", async () => {
    const config = {
      extraTop: { keep: true },
      worktree: {
        setup: ["npm install"],
        customWorktreeField: "preserve me",
      },
      scripts: {
        dev: {
          command: "npm run dev",
          type: "service",
          customScriptField: 123,
        },
      },
    };

    const result = await writeJAgentDeskConfigForEdit({
      repoRoot: tempDir,
      config,
      expectedRevision: null,
    });

    expect(result).toEqual({
      ok: true,
      config,
      revision: await statJAgentDeskConfigPath(tempDir),
    });
    expect(await readJAgentDeskConfigForEdit(tempDir)).toEqual({
      ok: true,
      config,
      revision: await statJAgentDeskConfigPath(tempDir),
    });
  });

  it("returns write_failed for filesystem write exceptions", async () => {
    const fileRoot = join(tempDir, "not-a-directory");
    writeFileSync(fileRoot, "file");

    const result = await writeJAgentDeskConfigForEdit({
      repoRoot: fileRoot,
      config: { worktree: { setup: "npm install" } },
      expectedRevision: null,
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "write_failed" },
    });
  });

  it("creates jagentdesk.json when the file is still missing and expected revision is null", async () => {
    mkdirSync(join(tempDir, "nested"));

    const result = await writeJAgentDeskConfigForEdit({
      repoRoot: join(tempDir, "nested"),
      config: { scripts: { dev: { command: "npm run dev" } } },
      expectedRevision: null,
    });

    expect(result).toEqual({
      ok: true,
      config: { scripts: { dev: { command: "npm run dev" } } },
      revision: await statJAgentDeskConfigPath(join(tempDir, "nested")),
    });
  });
});
