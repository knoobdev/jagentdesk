// Compare a migrated feature's contracts with the baseline revision:
//   node scripts/compare-builtin-contracts.mjs <baseline> <out-dir> [plugin...]
// For each plugin: handled request names, every wire message literal of the feature, agent tool
// names, and the app's i18n keys. Missing files at a revision contribute nothing.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import ts from "typescript";
const baseline = process.argv[2] ?? "plat/int10";
const output = process.argv[3] ?? ".dev/builtin-contracts";
const SESSION = "packages/server/src/server/session.ts";
const TOOLS = "packages/server/src/server/agent/tools/jagentdesk-tools.ts";
const DOCKER_PUSHES = new Set(["docker/snapshot", "docker/log-chunk", "docker/stats-data"]);
const isResponse = (name) => name.endsWith("/response") || name.endsWith(".response");
// requests: [file, regex] pairs whose first group is a handled inbound request name.
// wire: files whose string literals matching `wirePattern` are the feature's wire names.
const FEATURES = {
  docker: {
    requests: {
      baseline: [[SESSION, /"(docker\/[^"]+)"/g]],
      branch: [["plugins/docker/server/index.ts", /"(docker\/[^"]+)"/g]],
    },
    requestFilter: (name) => !isResponse(name) && !DOCKER_PUSHES.has(name) && name !== "docker/",
    tools: {
      baseline: [[TOOLS, /registerTool\(\s*"(docker_[^"]+)"/g]],
      branch: [["plugins/docker/server/agent-tools.ts", /registerTool\(\s*"(docker_[^"]+)"/g]],
    },
    sharedTools: [
      ["packages/server/src/server/ssh/remote-docker/agent-tools.ts", /"(docker_[a-z_]+)"/g],
    ],
  },
  clusters: {
    requests: {
      baseline: [[SESSION, /case "(cluster\/[^"]+)"/g]],
      branch: [["plugins/clusters/server/session.ts", /^\s*"(cluster\/[^"]+)",$/gm]],
    },
    wirePattern: /"(cluster\/[^"]+)"/g,
    wire: {
      baseline: [
        SESSION,
        "packages/server/src/server/session/cluster/cluster-session.ts",
        "packages/server/src/server/cluster/helm-client.ts",
      ],
      branch: [SESSION, "plugins/clusters/server"],
    },
    tools: {
      baseline: [[TOOLS, /registerTool\(\s*"((?:kubectl|cluster)_[^"]+)"/g]],
      branch: [
        [
          "plugins/clusters/server/agent-tools.ts",
          /registerTool\(\s*"((?:kubectl|cluster)_[^"]+)"/g,
        ],
      ],
    },
  },
  databases: {
    requests: {
      baseline: [[SESSION, /case "(database\/[^"]+)"/g]],
      branch: [["plugins/databases/server/session.ts", /^\s*"(database\/[^"]+)",$/gm]],
    },
    wirePattern: /"(database\/[^"]+)"/g,
    wire: {
      baseline: [SESSION, "packages/server/src/server/session/database/database-session.ts"],
      branch: [SESSION, "plugins/databases/server"],
    },
    tools: {
      baseline: [[TOOLS, /registerTool\(\s*"((?:sql|database)_[^"]+)"/g]],
      branch: [
        ["plugins/databases/server/agent-tools.ts", /registerTool\(\s*"((?:sql|database)_[^"]+)"/g],
      ],
    },
  },
  argocd: {
    requests: {
      baseline: [[SESSION, /case "(argocd\.[^"]+)"/g]],
      branch: [["plugins/argocd/server/argocd-session.ts", /^\s*"(argocd\.[^"]+)",$/gm]],
    },
    wirePattern: /"(argocd\.[a-z_.]+)"/g,
    wire: {
      baseline: [
        SESSION,
        "packages/server/src/server/session/argocd/argocd-session.ts",
        "packages/server/src/server/argocd",
      ],
      branch: [SESSION, "plugins/argocd/server"],
    },
    tools: {
      baseline: [["packages/server/src/server/argocd/agent-tools.ts", /name: "(argocd_[^"]+)"/g]],
      branch: [["plugins/argocd/server/agent-tools.ts", /name: "(argocd_[^"]+)"/g]],
    },
  },
};
const requested = process.argv.slice(4);
const plugins = requested.length ? requested : Object.keys(FEATURES);
fs.mkdirSync(output, { recursive: true });
const read = (revision, file) => {
  try {
    return revision === "worktree"
      ? fs.readFileSync(file, "utf8")
      : execFileSync("git", ["show", `${revision}:${file}`], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
  } catch {
    return "";
  }
};
// A directory entry expands to its non-test TypeScript files.
function expand(revision, entry) {
  if (entry.endsWith(".ts") || entry.endsWith(".tsx")) return [entry];
  const listed =
    revision === "worktree"
      ? (fs.existsSync(entry) ? fs.readdirSync(entry, { recursive: true }) : []).map((name) =>
          path.posix.join(entry, name),
        )
      : execFileSync("git", ["ls-tree", "-r", "--name-only", revision, entry], {
          encoding: "utf8",
        })
          .trim()
          .split("\n");
  return listed.filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file));
}
const matches = (revision, pairs) =>
  pairs.flatMap(([file, regex]) =>
    [...read(revision, file).matchAll(new RegExp(regex))].map((match) => match[1]),
  );
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
  return Object.fromEntries(files.map((file) => [file, propertyKeys(read(revision, file))]));
}
const unique = (values) => [...new Set(values)].sort();
function dump(id, revision) {
  const feature = FEATURES[id];
  const side = revision === "worktree" ? "branch" : "baseline";
  const filter = feature.requestFilter ?? ((name) => !isResponse(name));
  const result = {
    rpc: unique(matches(revision, feature.requests[side]).filter(filter)),
    tools: unique([
      ...matches(revision, feature.tools[side]),
      ...matches(revision, feature.sharedTools ?? []),
    ]),
  };
  if (feature.wire)
    result.wire = unique(
      feature.wire[side]
        .flatMap((entry) => expand(revision, entry))
        .flatMap((file) =>
          [...read(revision, file).matchAll(new RegExp(feature.wirePattern))].map(
            (match) => match[1],
          ),
        ),
    );
  return result;
}
const baselineI18n = i18n(baseline);
const branchI18n = i18n("worktree");
let failed = false;
for (const id of plugins) {
  if (!FEATURES[id]) throw new Error(`Unknown plugin: ${id}`);
  const before = { ...dump(id, baseline), i18n: baselineI18n };
  const after = { ...dump(id, "worktree"), i18n: branchI18n };
  const beforeFile = path.join(output, `${id}.baseline.json`);
  const afterFile = path.join(output, `${id}.branch.json`);
  fs.writeFileSync(beforeFile, JSON.stringify(before, null, 2) + "\n");
  fs.writeFileSync(afterFile, JSON.stringify(after, null, 2) + "\n");
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    failed = true;
    console.error(`${id}: contracts differ`);
    try {
      execFileSync("diff", ["-u", beforeFile, afterFile], { stdio: "inherit" });
    } catch {
      // diff exits non-zero on differences
    }
  } else
    console.log(
      `${id}: identical — ${after.rpc.length} RPCs, ${after.wire ? `${after.wire.length} wire names, ` : ""}${after.tools.length} tools, i18n keys in ${Object.keys(after.i18n).length} resource files`,
    );
}
if (failed) process.exitCode = 1;
