// Compares every built-in feature's contract with a baseline revision:
//   node scripts/compare-builtin-contracts.mjs <baseline> <out-dir> [plugin-id...]
// Per plugin: the wire names it owns (protocol literals with its prefixes that daemon code uses),
// the agent tool names daemon code registers, plus the app's i18n keys and the built-in manifest
// ids. Both revisions are scanned as whole trees, so a moved file keeps its names in the contract.
// `REMOVED` lists features deleted on purpose (ADR-0055); the script expects them gone and every
// other contract identical.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ts from "typescript";

const [baseline = "plat/int10", output = ".dev/builtin-contracts", ...only] = process.argv.slice(2);
const notResponse = (name) => !name.endsWith("/response") && !name.endsWith(".response");
// rpc: wire-name prefixes the feature owns. tools: tool-name prefixes or exact names.
const PLUGINS = {
  docker: { rpc: ["docker/"], tools: ["docker_"] },
  clusters: { rpc: ["cluster/"], tools: ["kubectl_", "cluster_"] },
  databases: { rpc: ["database/"], tools: ["sql_", "database_"] },
  argocd: { rpc: ["argocd."], tools: ["argocd_"] },
  "ssh-servers": { rpc: ["ssh."], tools: ["ssh_"] },
  "remote-tasks": { rpc: ["remote_exec."], tools: ["remote_"] },
  "custom-providers": { rpc: ["providers.custom."], tools: ["provider_"] },
  jira: { rpc: ["jira."], tools: ["jira_"] },
  // forge.search.request is the core checkout search.
  "forge-hub": { rpc: ["forge."], exclude: ["forge.search.request"], tools: ["forge_"] },
  devices: {
    rpc: ["simulator/", "sideload.", "android."],
    tools: ["sim_", "sideload_", "android_"],
    excludeTools: ["sim_install_batch"],
  },
  workbench: { rpc: ["proxy/"], tools: ["proxy_", "sim_install_batch"] },
  skills: { rpc: ["skills/", "skills.", "agent.skills."], tools: ["create_skill", "update_skill"] },
  "spec-mode": { rpc: ["agent.spec_mode."], tools: [] },
  autorun: { rpc: ["autorun."], tools: [] },
  insights: { rpc: ["usage.history."], tools: [] },
  "session-share": { rpc: ["session.share."], tools: [] },
  "browser-tools": { rpc: ["browser."], tools: ["browser_"] },
  "activity-graph": { rpc: ["agent.activity_graph."], tools: [] },
  figma: { rpc: ["figma."], tools: ["figma_"] },
};
const REMOVED = new Set(["activity-graph", "figma"]);
// i18n keys of removed features: any key path segment naming them, or any key of a resource file
// the feature owned (resources/activity-graph.ts held the activityGraph subtree).
const REMOVED_I18N = /(^|\.)(figma[A-Za-z]*|activityGraph[A-Za-z]*)(\.|$)/;
const REMOVED_I18N_FILE = /[/\\](activity-graph|figma)\.(ts|json)$/;
const ids = only.length ? only : Object.keys(PLUGINS);
const ROOTS = ["packages/server/src", "plugins", "packages/protocol/src", "packages/app/src/i18n"];

function checkout(revision) {
  if (revision === "worktree") return process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "builtin-contracts-"));
  const present = ROOTS.filter((root) => {
    try {
      execFileSync("git", ["cat-file", "-e", `${revision}:${root}`], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
  execFileSync("sh", ["-c", `git archive ${revision} ${present.join(" ")} | tar -x -C "${dir}"`]);
  return dir;
}
function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, files);
    else files.push(file);
  }
  return files;
}
const isSource = (file) =>
  /\.(ts|tsx|mts)$/.test(file) &&
  !/\.(test|spec|e2e)\.[mc]?tsx?$|\.e2e\.test\.|[/\\](test-support|test-fixtures|fixtures)[/\\]/.test(
    file,
  );
function scan(revision) {
  const root = checkout(revision);
  const daemon = [
    ...walk(path.join(root, "packages/server/src")),
    ...walk(path.join(root, "plugins")).filter((file) => /[/\\]server[/\\]/.test(file)),
  ].filter(isSource);
  const literals = new Set();
  const tools = new Set();
  for (const file of daemon) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/"([a-z][A-Za-z0-9_./-]*)"/g)) literals.add(match[1]);
    for (const match of source.matchAll(
      /(?:registerTool|registerSimulatorOnly|actionTool)\(\s*"([a-z][a-z0-9_]*)"|\bname:\s*"([a-z][a-z0-9_]*)"/g,
    ))
      tools.add(match[1] ?? match[2]);
  }
  const wire = new Set();
  for (const file of walk(path.join(root, "packages/protocol/src")).filter(isSource)) {
    const source = fs.readFileSync(file, "utf8");
    // Schema helpers differ per feature; any protocol string literal is a candidate wire name.
    for (const match of source.matchAll(/"([a-z][A-Za-z0-9_./-]*)"/g)) wire.add(match[1]);
  }
  const i18n = {};
  for (const file of walk(path.join(root, "packages/app/src/i18n/resources")).filter((entry) =>
    /\.(ts|json)$/.test(entry),
  ))
    i18n[path.relative(root, file)] = propertyKeys(fs.readFileSync(file, "utf8"));
  // Built-in ids as the protocol declares them (generated from manifests after phase 2).
  const manifests = [];
  for (const name of ["builtin-plugins.ts", "builtin-plugins.generated.ts"]) {
    const file = path.join(root, "packages/protocol/src", name);
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(
      /export const (?:STATIC_BUILTIN|BUNDLED)_PLUGIN_IDS = \[([^\]]*)\]/g,
    ))
      manifests.push(...[...match[1].matchAll(/"([^"]+)"/g)].map((id) => id[1]));
  }
  manifests.sort();
  if (root !== process.cwd()) fs.rmSync(root, { recursive: true, force: true });
  return { literals, tools, wire, i18n, manifests };
}
function propertyKeys(source) {
  const file = ts.createSourceFile("resource.ts", source, ts.ScriptTarget.Latest, true);
  const keys = [];
  function visit(node, prefix = []) {
    if (ts.isPropertyAssignment(node)) {
      const key = ts.isStringLiteral(node.name) ? node.name.text : node.name.getText(file);
      const parts = [...prefix, key];
      if (ts.isObjectLiteralExpression(node.initializer))
        for (const child of node.initializer.properties) visit(child, parts);
      else keys.push(parts.join("."));
      return;
    }
    ts.forEachChild(node, (child) => visit(child, prefix));
  }
  visit(file);
  return keys.sort();
}
const hasPrefix = (name, prefixes) =>
  prefixes.some((prefix) =>
    prefix.endsWith("_") || prefix.endsWith(".") || prefix.endsWith("/")
      ? name.startsWith(prefix)
      : name === prefix,
  );
function contract(id, side) {
  const spec = PLUGINS[id];
  const rpc = [...side.literals]
    .filter((name) => side.wire.has(name) && hasPrefix(name, spec.rpc))
    .filter((name) => notResponse(name) && !spec.exclude?.includes(name))
    .sort();
  const tools = [...side.tools]
    .filter((name) => hasPrefix(name, spec.tools) && !spec.excludeTools?.includes(name))
    .sort();
  return { rpc, tools };
}

fs.mkdirSync(output, { recursive: true });
const before = scan(baseline);
const after = scan("worktree");
let failed = false;
const report = [];
for (const id of ids) {
  if (!PLUGINS[id]) throw new Error(`Unknown plugin: ${id}`);
  const a = contract(id, before);
  const b = contract(id, after);
  fs.writeFileSync(path.join(output, `${id}.baseline.json`), JSON.stringify(a, null, 2) + "\n");
  fs.writeFileSync(path.join(output, `${id}.branch.json`), JSON.stringify(b, null, 2) + "\n");
  if (REMOVED.has(id)) {
    const gone = b.rpc.length === 0 && b.tools.length === 0 && !after.manifests.includes(id);
    if (!gone) failed = true;
    report.push(
      `${id}: ${gone ? "removed" : "NOT REMOVED"} — baseline ${a.rpc.length} RPCs/wire names, ${a.tools.length} tools; branch ${b.rpc.length}/${b.tools.length}`,
    );
    continue;
  }
  if (JSON.stringify(a) === JSON.stringify(b)) {
    report.push(`${id}: identical — ${b.rpc.length} wire names, ${b.tools.length} tools`);
    continue;
  }
  failed = true;
  const missing = (x, y) => x.filter((name) => !y.includes(name));
  report.push(
    `${id}: DIFFERS — rpc -[${missing(a.rpc, b.rpc)}] +[${missing(b.rpc, a.rpc)}] tools -[${missing(a.tools, b.tools)}] +[${missing(b.tools, a.tools)}]`,
  );
}
// i18n: only the removed features' keys may disappear; nothing may be added.
const i18nDiff = { removed: [], added: [], unexpected: [] };
for (const file of new Set([...Object.keys(before.i18n), ...Object.keys(after.i18n)])) {
  const a = new Set(before.i18n[file] ?? []);
  const b = new Set(after.i18n[file] ?? []);
  for (const key of a)
    if (!b.has(key))
      (REMOVED_I18N.test(key) || REMOVED_I18N_FILE.test(file)
        ? i18nDiff.removed
        : i18nDiff.unexpected
      ).push(`${file}: -${key}`);
  for (const key of b) if (!a.has(key)) i18nDiff.unexpected.push(`${file}: +${key}`);
}
if (i18nDiff.unexpected.length) failed = true;
report.push(
  `i18n: ${Object.keys(after.i18n).length} resource files; ${i18nDiff.removed.length} removed-feature keys gone; ${i18nDiff.unexpected.length} other differences`,
);
for (const line of i18nDiff.unexpected.slice(0, 40)) report.push(`  ${line}`);
const manifestRemoved = before.manifests.filter((id) => !after.manifests.includes(id));
const manifestAdded = after.manifests.filter((id) => !before.manifests.includes(id));
if (manifestAdded.length || manifestRemoved.some((id) => !REMOVED.has(id))) failed = true;
report.push(
  `manifests: ${after.manifests.length} built-ins; removed [${manifestRemoved}]; added [${manifestAdded}]`,
);
fs.writeFileSync(path.join(output, "i18n-diff.json"), JSON.stringify(i18nDiff, null, 2) + "\n");
fs.writeFileSync(path.join(output, "report.txt"), report.join("\n") + "\n");
console.log(report.join("\n"));
if (failed) process.exitCode = 1;
