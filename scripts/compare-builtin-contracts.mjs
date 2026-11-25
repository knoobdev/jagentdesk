import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import ts from "typescript";
const baseline = process.argv[2] ?? "plat/int10";
const output = process.argv[3] ?? ".dev/builtin-contracts";
fs.mkdirSync(output, { recursive: true });
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
function dump(revision) {
  const old = revision !== "worktree";
  const rpcSource = read(
    revision,
    old ? "packages/server/src/server/session.ts" : "plugins/docker/server/index.ts",
  );
  const rpc = [...rpcSource.matchAll(/"(docker\/[^"]+)"/g)]
    .map((m) => m[1])
    .filter(
      (name) =>
        !name.endsWith("/response") &&
        !["docker/snapshot", "docker/log-chunk", "docker/stats-data"].includes(name),
    );
  const toolSource = read(
    revision,
    old
      ? "packages/server/src/server/agent/tools/jagentdesk-tools.ts"
      : "plugins/docker/server/agent-tools.ts",
  );
  const tools = [...toolSource.matchAll(/registerTool\(\s*"(docker_[^"]+)"/g)].map((m) => m[1]);
  const remoteTools = read(revision, "packages/server/src/server/ssh/remote-docker/agent-tools.ts");
  tools.push(...[...remoteTools.matchAll(/"(docker_[a-z_]+)"/g)].map((m) => m[1]));
  const files = execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", baseline, "packages/app/src/i18n/resources"],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n");
  const i18n = Object.fromEntries(
    files
      .filter((file) => /\.(ts|json)$/.test(file))
      .map((file) => [file, propertyKeys(read(revision, file))]),
  );
  return {
    rpc: [...new Set(rpc)].filter((name) => name !== "docker/").sort(),
    tools: [...new Set(tools)].sort(),
    i18n,
  };
}
const before = dump(baseline),
  after = dump("worktree");
for (const [name, data] of [
  ["int10", before],
  ["branch", after],
])
  fs.writeFileSync(path.join(output, `${name}.json`), JSON.stringify(data, null, 2) + "\n");
if (JSON.stringify(before) !== JSON.stringify(after)) {
  execFileSync("diff", ["-u", path.join(output, "int10.json"), path.join(output, "branch.json")], {
    stdio: "inherit",
  });
  process.exitCode = 1;
} else
  console.log(
    `Identical: ${after.rpc.length} Docker RPCs, ${after.tools.length} Docker tools, i18n keys in ${Object.keys(after.i18n).length} resource files`,
  );
