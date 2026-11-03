#!/usr/bin/env node
// Records what the real `specify init` 1.3.0 writes, as the reference for
// src/server/spec-mode/speckit/layout.test.ts (spec 28.8 criterion 1).
//
//   uv venv /tmp/speckit-venv && VIRTUAL_ENV=/tmp/speckit-venv uv pip install specify-cli==1.3.0
//   node scripts/capture-speckit-fixtures.mjs /tmp/speckit-venv/bin/specify
//
// Each fixture lists every file (path → sha256 + mode). Manifest timestamps are replaced by
// "<timestamp>" before hashing because they are the only bytes that differ between runs.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const specify = process.argv[2];
if (!specify) {
  console.error("usage: capture-speckit-fixtures.mjs <path to specify 1.3.0>");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(here, "../src/server/spec-mode/speckit/fixtures");

const CONFIGS = [
  {
    name: "claude-sh",
    args: [
      "--integration",
      "claude",
      "--script",
      "sh",
      "--integration-options=--no-model-invocation",
    ],
  },
  {
    name: "claude-ps",
    args: [
      "--integration",
      "claude",
      "--script",
      "ps",
      "--integration-options=--no-model-invocation",
    ],
  },
  { name: "codex-sh", args: ["--integration", "codex", "--script", "sh"] },
  {
    name: "copilot-sh",
    args: [
      "--integration",
      "copilot",
      "--script",
      "sh",
      "--integration-options=--no-model-invocation",
    ],
  },
  { name: "opencode-sh", args: ["--integration", "opencode", "--script", "sh"] },
  { name: "pi-sh", args: ["--integration", "pi", "--script", "sh"] },
  { name: "omp-sh", args: ["--integration", "omp", "--script", "sh"] },
];

export function normalizeTimestamps(text) {
  return text.replace(/"(installed_at|updated_at)": "[^"]*"/g, '"$1": "<timestamp>"');
}

function listFiles(root, dir = root) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory()
      ? listFiles(root, full)
      : [path.relative(root, full).split(path.sep).join("/")];
  });
}

const version = execFileSync(specify, ["version"], { encoding: "utf8" });
if (!/CLI Version\s+1\.3\.0/.test(version)) {
  console.error("specify is not version 1.3.0");
  process.exit(1);
}

for (const config of CONFIGS) {
  const project = mkdtempSync(path.join(tmpdir(), "speckit-fixture-"));
  try {
    const args = ["init", "--here", "--force", "--ignore-agent-tools", ...config.args];
    execFileSync(specify, args, { cwd: project, stdio: "ignore" });
    const files = {};
    for (const file of listFiles(project).sort()) {
      const full = path.join(project, file);
      const content = normalizeTimestamps(readFileSync(full, "utf8"));
      files[file] = {
        sha256: createHash("sha256").update(content, "utf8").digest("hex"),
        mode: (statSync(full).mode & 0o777).toString(8),
      };
    }
    const fixture = { specify: `specify ${args.join(" ")}`, specifyVersion: "1.3.0", files };
    writeFileSync(
      path.join(fixtureDir, `${config.name}.json`),
      `${JSON.stringify(fixture, null, 2)}\n`,
    );
    console.log(`${config.name}: ${Object.keys(files).length} files`);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}
