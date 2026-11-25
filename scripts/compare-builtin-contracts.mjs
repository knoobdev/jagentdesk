// Compares a migrated feature's wire contract with a baseline revision: inbound RPC names,
// agent tool names and i18n resource keys. Usage:
//   node scripts/compare-builtin-contracts.mjs <baseline> <out-dir> [plugin ...]
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import ts from "typescript";
const [baseline = "plat/int10", output = ".dev/builtin-contracts", ...only] = process.argv.slice(2);
fs.mkdirSync(output, { recursive: true });

const S = "packages/server/src/server";
const DOCKER_STREAM_PUSHES = new Set(["docker/snapshot", "docker/log-chunk", "docker/stats-data"]);
/** Per plugin: where its RPC handlers and tool definitions live before and after the move. */
const SPECS = {
  docker: {
    rpc: /"(docker\/[^"]+)"/g,
    rpcFilter: (name) =>
      !name.endsWith("/response") && name !== "docker/" && !DOCKER_STREAM_PUSHES.has(name),
    tool: /(?:registerTool\(\s*|name: )"(docker_[a-z_]+)"/g,
    before: {
      rpc: [`${S}/session.ts`],
      tools: [`${S}/agent/tools/jagentdesk-tools.ts`, `${S}/ssh/remote-docker/agent-tools.ts`],
    },
    after: {
      rpc: ["plugins/docker/server/index.ts"],
      tools: [
        "plugins/docker/server/agent-tools.ts",
        "plugins/ssh-servers/server/remote-docker-tools.ts",
      ],
    },
  },
  "ssh-servers": {
    rpc: /"(ssh\.[a-z0-9_.]+\.request)"/g,
    tool: /name: "((?:ssh|docker)_[a-z_]+)"/g,
    before: {
      rpc: [`${S}/session/ssh/ssh-session.ts`, `${S}/ssh/**/rpc.ts`],
      tools: [`${S}/ssh/environment/agent-tools.ts`, `${S}/ssh/remote-docker/agent-tools.ts`],
    },
    after: {
      rpc: ["plugins/ssh-servers/server/session.ts", "plugins/ssh-servers/server/rpc/*.ts"],
      registered: ["plugins/ssh-servers/server/index.ts"],
      tools: [
        "plugins/ssh-servers/server/agent-tools.ts",
        "plugins/ssh-servers/server/remote-docker-tools.ts",
      ],
    },
  },
  "remote-tasks": {
    rpc: /"(remote_exec\.[a-z0-9_.]+\.request)"/g,
    tool: /name: "(remote_[a-z_]+)"/g,
    before: {
      rpc: [`${S}/remote-exec/rpc.ts`],
      tools: [`${S}/remote-exec/agent-tools.ts`],
    },
    after: {
      rpc: ["plugins/remote-tasks/server/rpc.ts"],
      registered: ["plugins/remote-tasks/server/index.ts"],
      tools: ["plugins/remote-tasks/server/agent-tools.ts"],
    },
  },
  "custom-providers": {
    rpc: /"(providers\.custom\.[a-z0-9_.]+\.request)"/g,
    tool: /name: "(provider_[a-z_]+)"/g,
    before: {
      rpc: [`${S}/custom-providers/rpc.ts`],
      tools: [`${S}/custom-providers/agent-tools.ts`],
    },
    after: {
      rpc: ["plugins/custom-providers/server/rpc.ts"],
      registered: ["plugins/custom-providers/server/index.ts"],
      tools: ["plugins/custom-providers/server/agent-tools.ts"],
    },
  },
};

// Inbound wire names accepted by the daemon (packages/protocol must be built).
const messages = await import(path.resolve("packages/protocol/dist/messages.js"));
const inbound = new Set(
  messages.SessionInboundMessageSchema.options.map((option) => option.shape.type.value),
);
const read = (revision, file) =>
  revision === "worktree"
    ? fs.readFileSync(file, "utf8")
    : execFileSync("git", ["show", `${revision}:${file}`], { encoding: "utf8" });
function listFiles(revision, dir) {
  if (revision !== "worktree")
    return execFileSync("git", ["ls-tree", "-r", "--name-only", revision, dir], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean);
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const name of fs.readdirSync(d)) {
      const file = path.posix.join(d, name);
      if (fs.statSync(file).isDirectory()) walk(file);
      else out.push(file);
    }
  };
  walk(dir);
  return out;
}
function expand(revision, patterns) {
  return patterns.flatMap((pattern) => {
    if (!pattern.includes("*")) return [pattern];
    const dir = pattern.slice(0, pattern.indexOf("*")).replace(/\/$/, "");
    const regex = new RegExp(
      "^" +
        pattern
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*\//g, "(?:.*/)?")
          .replace(/\*/g, "[^/]*") +
        "$",
    );
    // Tests and fixtures are not part of the shipped contract.
    return listFiles(revision, dir).filter(
      (file) => regex.test(file) && !/\.(test|spec)\.ts$|test-|fixtures?\//.test(file),
    );
  });
}
function matches(revision, patterns, regex) {
  const names = new Set();
  for (const file of expand(revision, patterns))
    for (const m of read(revision, file).matchAll(regex)) names.add(m[1]);
  return names;
}
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
const i18nFiles = listFiles(baseline, "packages/app/src/i18n/resources").filter((file) =>
  /\.(ts|json)$/.test(file),
);
function i18n(revision) {
  return Object.fromEntries(i18nFiles.map((file) => [file, propertyKeys(read(revision, file))]));
}
function dump(id, revision) {
  const spec = SPECS[id];
  const side = revision === "worktree" ? spec.after : spec.before;
  let rpc = [...matches(revision, side.rpc, spec.rpc)].filter(
    (name) => inbound.has(name) && (spec.rpcFilter ?? (() => true))(name),
  );
  if (side.registered) {
    // A registered name must also have a handler in the feature.
    const registered = matches(revision, side.registered, spec.rpc);
    rpc = rpc.filter((name) => registered.has(name));
    const unhandled = [...registered].filter((name) => !rpc.includes(name) || !inbound.has(name));
    if (unhandled.length) rpc.push(...unhandled.map((name) => `UNHANDLED ${name}`));
  }
  return {
    rpc: [...new Set(rpc)].sort(),
    tools: [...matches(revision, side.tools, spec.tool)].sort(),
  };
}
const ids = only.length ? only : Object.keys(SPECS);
const strings = { before: i18n(baseline), after: i18n("worktree") };
let failed = false;
for (const id of ids) {
  const before = { ...dump(id, baseline), i18n: strings.before };
  const after = { ...dump(id, "worktree"), i18n: strings.after };
  const files = [path.join(output, `${id}.baseline.json`), path.join(output, `${id}.branch.json`)];
  fs.writeFileSync(files[0], JSON.stringify(before, null, 2) + "\n");
  fs.writeFileSync(files[1], JSON.stringify(after, null, 2) + "\n");
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    failed = true;
    console.error(`${id}: differs from ${baseline}`);
    try {
      execFileSync("diff", ["-u", ...files], { stdio: "inherit" });
    } catch {}
  } else
    console.log(
      `${id}: identical — ${after.rpc.length} RPCs, ${after.tools.length} tools, i18n keys in ${Object.keys(after.i18n).length} resource files`,
    );
}
if (failed) process.exitCode = 1;
