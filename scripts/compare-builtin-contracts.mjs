// Compares a migrated built-in's wire contract with a baseline revision:
//   node scripts/compare-builtin-contracts.mjs <baseline> <out-dir> [plugin-id...]
// RPCs: inbound wire names the plugin's prefixes own that appear in the dispatch sources.
// Tools: agent tool names registered in the tool sources. i18n: every resource key.
// Requires a built @jagentdesk/protocol (npm run build:client) for the inbound name list.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import ts from "typescript";
const baseline = process.argv[2] ?? "plat/int10";
const output = process.argv[3] ?? ".dev/builtin-contracts";
const S = "packages/server/src/server";
const T = `${S}/agent/tools/jagentdesk-tools.ts`;
/** Baseline sources are the phase 1 locations; branch sources are the plugin plus remaining core. */
const PLUGINS = {
  docker: {
    rpcPrefixes: ["docker/"],
    toolPrefixes: ["docker_"],
    baseline: {
      rpc: [`${S}/session.ts`],
      tools: [T, `${S}/ssh/remote-docker/agent-tools.ts`],
    },
    branch: {
      rpc: ["plugins/docker/server/index.ts"],
      tools: ["plugins/docker/server/agent-tools.ts", `${S}/ssh/remote-docker/agent-tools.ts`],
    },
  },
  skills: {
    rpcPrefixes: ["skills/", "skills.", "agent.skills."],
    toolNames: ["create_skill", "update_skill"],
    baseline: {
      rpc: [`${S}/session.ts`, `${S}/skills-native/session-handler.ts`],
      tools: [T],
    },
    branch: {
      rpc: [`${S}/session.ts`, "plugins/skills/server/index.ts"],
      tools: [T, "plugins/skills/server/agent-tools.ts"],
    },
  },
  "spec-mode": {
    rpcPrefixes: ["agent.spec_mode."],
    baseline: {
      rpc: [`${S}/session.ts`, `${S}/session/spec-mode/spec-mode-session.ts`],
      tools: [T],
    },
    branch: { rpc: [`${S}/session.ts`, "plugins/spec-mode/server/index.ts"], tools: [T] },
  },
  autorun: {
    rpcPrefixes: ["autorun."],
    baseline: { rpc: [`${S}/session.ts`, `${S}/session/autorun/autorun-session.ts`], tools: [T] },
    branch: { rpc: [`${S}/session.ts`, "plugins/autorun/server/index.ts"], tools: [T] },
  },
  "activity-graph": {
    rpcPrefixes: ["agent.activity_graph."],
    baseline: {
      rpc: [`${S}/session.ts`, `${S}/session/activity-graph/activity-graph-session.ts`],
      tools: [T],
    },
    branch: { rpc: [`${S}/session.ts`, "plugins/activity-graph/server/index.ts"], tools: [T] },
  },
  insights: {
    rpcPrefixes: ["usage.history."],
    baseline: { rpc: [`${S}/session.ts`], tools: [T] },
    branch: { rpc: [`${S}/session.ts`, "plugins/insights/server/index.ts"], tools: [T] },
  },
};
const ids = process.argv.slice(4).length ? process.argv.slice(4) : Object.keys(PLUGINS);
fs.mkdirSync(output, { recursive: true });
const { SessionInboundMessageSchema } = await import(
  new URL("../packages/protocol/dist/messages.js", import.meta.url)
);
const inbound = new Set(
  SessionInboundMessageSchema.options.map((option) => option.shape.type.value),
);
const exists = (revision, file) => {
  if (revision === "worktree") return fs.existsSync(file);
  try {
    execFileSync("git", ["cat-file", "-e", `${revision}:${file}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const read = (revision, file) =>
  revision === "worktree"
    ? fs.readFileSync(file, "utf8")
    : execFileSync("git", ["show", `${revision}:${file}`], { encoding: "utf8" });
function propertyKeys(source) {
  const file = ts.createSourceFile("resource.ts", source, ts.ScriptTarget.Latest, true);
  const keys = [];
  function walk(node, prefix = []) {
    if (ts.isPropertyAssignment(node)) {
      const key = ts.isStringLiteral(node.name) ? node.name.text : node.name.getText(file);
      const parts = [...prefix, key];
      if (ts.isObjectLiteralExpression(node.initializer))
        for (const child of node.initializer.properties) walk(child, parts);
      else keys.push(parts.join("."));
      return;
    }
    ts.forEachChild(node, (child) => walk(child, prefix));
  }
  walk(file);
  return keys.sort();
}
function literals(revision, files) {
  return files
    .filter((file) => exists(revision, file))
    .flatMap((file) => [...read(revision, file).matchAll(/"([^"\s]+)"/g)].map((m) => m[1]));
}
function dump(revision, config) {
  const sources = revision === "worktree" ? config.branch : config.baseline;
  const rpc = literals(revision, sources.rpc).filter(
    (name) => inbound.has(name) && config.rpcPrefixes.some((prefix) => name.startsWith(prefix)),
  );
  const tools = literals(revision, sources.tools).filter(
    (name) =>
      config.toolNames?.includes(name) ||
      (config.toolPrefixes?.some((prefix) => name.startsWith(prefix)) &&
        /^[a-z][a-z0-9_]*$/.test(name)),
  );
  return { rpc: [...new Set(rpc)].sort(), tools: [...new Set(tools)].sort() };
}
const files = execFileSync(
  "git",
  ["ls-tree", "-r", "--name-only", baseline, "packages/app/src/i18n/resources"],
  { encoding: "utf8" },
)
  .trim()
  .split("\n")
  .filter((file) => /\.(ts|json)$/.test(file));
const i18n = (revision) =>
  Object.fromEntries(files.map((file) => [file, propertyKeys(read(revision, file))]));
const baseI18n = i18n(baseline);
const branchI18n = i18n("worktree");
let failed = false;
for (const id of ids) {
  const config = PLUGINS[id];
  if (!config) throw new Error(`No contract config for ${id}`);
  const before = { ...dump(baseline, config), i18n: baseI18n };
  const after = { ...dump("worktree", config), i18n: branchI18n };
  const base = path.join(output, `${id}-baseline.json`);
  const branch = path.join(output, `${id}-branch.json`);
  fs.writeFileSync(base, JSON.stringify(before, null, 2) + "\n");
  fs.writeFileSync(branch, JSON.stringify(after, null, 2) + "\n");
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    failed = true;
    try {
      execFileSync("diff", ["-u", base, branch], { stdio: "inherit" });
    } catch {}
  } else
    console.log(
      `${id}: identical — ${after.rpc.length} RPCs, ${after.tools.length} tools, i18n keys in ${Object.keys(after.i18n).length} resource files`,
    );
}
if (failed) process.exitCode = 1;
