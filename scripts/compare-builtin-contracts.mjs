// Compares each migrated built-in's RPC names, agent tool names, and the app i18n keys against
// a baseline revision. Baseline names are read from the pre-migration sources; current names
// come from the real host registration (scripts/dump-builtin-registrations.mts).
//   node scripts/compare-builtin-contracts.mjs plat/int10 <out-dir> [plugin-id ...]
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import ts from "typescript";
const baseline = process.argv[2] ?? "plat/int10";
const output = process.argv[3] ?? ".dev/builtin-contracts";
const SESSION = "packages/server/src/server/session.ts";
const TOOLS = "packages/server/src/server/agent/tools/jagentdesk-tools.ts";
const requests = (prefix) => (name) => name.startsWith(prefix) && name.endsWith(".request");
// Baseline sources per plugin: where its inbound RPC names and agent tool names were literal.
const PLUGINS = {
  docker: {
    rpcFiles: [SESSION],
    rpc: (name) =>
      name.startsWith("docker/") &&
      name !== "docker/" &&
      !name.endsWith("/response") &&
      !["docker/snapshot", "docker/log-chunk", "docker/stats-data"].includes(name),
    toolFiles: [TOOLS],
    tool: /registerTool\(\s*"(docker_[^"]+)"/g,
  },
  jira: {
    rpcFiles: [SESSION],
    rpc: requests("jira."),
    toolFiles: ["packages/server/src/server/jira/agent-tools.ts"],
    tool: /name: "(jira_[a-z_]+)"/g,
  },
  "forge-hub": {
    rpcFiles: [SESSION],
    // forge.search.request is the core checkout search, not Forge Hub.
    rpc: (name) => requests("forge.")(name) && name !== "forge.search.request",
    toolFiles: [TOOLS],
    tool: /registerTool\(\s*"(forge_[^"]+)"/g,
  },
};
const ids = process.argv.slice(4).length ? process.argv.slice(4) : Object.keys(PLUGINS);
fs.mkdirSync(output, { recursive: true });
const read = (revision, file) =>
  execFileSync("git", ["show", `${revision}:${file}`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
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
function i18n(revision) {
  const files = execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", baseline, "packages/app/src/i18n/resources"],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter((file) => /\.(ts|json)$/.test(file));
  return Object.fromEntries(
    files.map((file) => [
      file,
      propertyKeys(revision === "worktree" ? fs.readFileSync(file, "utf8") : read(revision, file)),
    ]),
  );
}
function baselineDump(id) {
  const plugin = PLUGINS[id];
  const rpc = plugin.rpcFiles
    .flatMap((file) => [...read(baseline, file).matchAll(/"([a-z][a-z0-9_./-]*)"/g)])
    .map((match) => match[1])
    .filter(plugin.rpc);
  const tools = plugin.toolFiles.flatMap((file) =>
    [...read(baseline, file).matchAll(plugin.tool)].map((match) => match[1]),
  );
  // SSH servers re-register the server-aware docker_* tools under the same names.
  if (id === "docker") {
    const remote = read(baseline, "packages/server/src/server/ssh/remote-docker/agent-tools.ts");
    tools.push(...[...remote.matchAll(/"(docker_[a-z_]+)"/g)].map((match) => match[1]));
  }
  return { rpc: [...new Set(rpc)].sort(), tools: [...new Set(tools)].sort() };
}
const current = JSON.parse(
  execFileSync("npx", ["tsx", "scripts/dump-builtin-registrations.mts", ...ids], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }),
);
if (ids.includes("docker")) {
  const remote = fs.readFileSync(
    "packages/server/src/server/ssh/remote-docker/agent-tools.ts",
    "utf8",
  );
  current.docker.tools = [
    ...new Set([
      ...current.docker.tools,
      ...[...remote.matchAll(/"(docker_[a-z_]+)"/g)].map((match) => match[1]),
    ]),
  ].sort();
}
const before = { plugins: {}, i18n: i18n(baseline) };
const after = { plugins: {}, i18n: i18n("worktree") };
for (const id of ids) {
  before.plugins[id] = baselineDump(id);
  after.plugins[id] = current[id];
}
fs.writeFileSync(path.join(output, "baseline.json"), JSON.stringify(before, null, 2) + "\n");
fs.writeFileSync(path.join(output, "branch.json"), JSON.stringify(after, null, 2) + "\n");
if (JSON.stringify(before) !== JSON.stringify(after)) {
  try {
    execFileSync(
      "diff",
      ["-u", path.join(output, "baseline.json"), path.join(output, "branch.json")],
      { stdio: "inherit" },
    );
  } catch {}
  process.exitCode = 1;
} else {
  for (const id of ids)
    console.log(
      `Identical ${id}: ${after.plugins[id].rpc.length} RPCs, ${after.plugins[id].tools.length} tools`,
    );
  console.log(`Identical i18n keys in ${Object.keys(after.i18n).length} resource files`);
}
