import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { isBuiltin } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as server from "./server/index.js";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const entries = {
  ".": "shared",
  "./server": "server",
  "./server/provider": "server",
  "./server/acp": "server",
  "./internal/lifecycle": "server",
  "./client": "client",
  "./client/host": "client",
  "./client/react-native": "client",
  "./client/ui": "client",
} as const;
const uiDependency = /^(react(?:-dom|-native)?|use-sync-external-store)(\/|$)/;
const serverModule = /^server\//;
const clientModule = /^client\//;

function resolveLocal(importer: string, specifier: string): string {
  const base = path.resolve(path.dirname(importer), specifier.replace(/\.js$/, ""));
  const result = [base + ".ts", base + ".tsx"].find(existsSync);
  if (!result) throw new Error(`Cannot resolve ${specifier} from ${importer}`);
  return result;
}

function boundaryViolations(entry: string, runtime: "shared" | "server" | "client"): string[] {
  const pending = [entry];
  const visited = new Set<string>();
  const violations: string[] = [];
  while (pending.length) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    // Includes type imports, re-exports, import types, and literal dynamic imports.
    const imports = ts.preProcessFile(readFileSync(file, "utf8"), true, true).importedFiles;
    for (const { fileName: specifier } of imports) {
      const label = `${path.relative(sourceDirectory, file)} -> ${specifier}`;
      if (specifier.startsWith(".")) {
        const local = resolveLocal(file, specifier);
        const module = path
          .relative(sourceDirectory, local)
          .replace(/\\/g, "/")
          .replace(/\.tsx?$/, ".js");
        if (runtime !== "client" && clientModule.test(module)) violations.push(label);
        if (runtime !== "server" && serverModule.test(module)) violations.push(label);
        pending.push(local);
      } else if (runtime === "shared") {
        if (specifier !== "zod" && specifier !== "@jagentdesk/protocol/agent-types")
          violations.push(label);
      } else if (runtime === "server") {
        if (uiDependency.test(specifier) || /^@jagentdesk\/plugin\/client(\/|$)/.test(specifier))
          violations.push(label);
      } else if (isBuiltin(specifier) || /^@jagentdesk\/plugin\/server(\/|$)/.test(specifier)) {
        violations.push(label);
      }
    }
  }
  return violations;
}

describe("plugin SDK import boundaries", () => {
  it("publishes process capabilities without their Windows implementation helpers", () => {
    expect(Object.keys(server).sort()).toEqual([
      "defineAgentTool",
      "execCommand",
      "spawnProcess",
      "terminateProcess",
    ]);
  });

  it("classifies every published entry", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(Object.keys(manifest.exports).sort()).toEqual(Object.keys(entries).sort());
  });

  it.each(Object.entries(entries))(
    "%s respects its %s boundary, including type dependencies",
    (specifier, runtime) => {
      const file = path.resolve(sourceDirectory, "..", manifest.exports[specifier].source);
      expect(boundaryViolations(file, runtime)).toEqual([]);
    },
  );
});

describe("plugin example import boundaries", () => {
  const examples = path.resolve(sourceDirectory, "../../../plugin-examples");
  const files = readdirSync(examples, { recursive: true }).filter((file) =>
    /(?<!\.test)\.tsx?$/.test(file),
  );
  const owner = (file: string) => {
    const [, directory] = path.relative(examples, file).split(path.sep);
    if (directory?.startsWith("index.client.")) return "client";
    if (directory?.startsWith("index.server.")) return "server";
    return directory;
  };

  it.each(files)("%s respects runtime ownership, including type imports", (relative) => {
    const file = path.join(examples, relative);
    const runtime = owner(file);
    expect(["shared", "client", "server"]).toContain(runtime);
    const violations: string[] = [];
    for (const { fileName: specifier } of ts.preProcessFile(readFileSync(file, "utf8"), true, true)
      .importedFiles) {
      if (specifier.startsWith(".")) {
        const imported = owner(resolveLocal(file, specifier));
        if (imported !== "shared" && imported !== runtime) violations.push(specifier);
      } else if (specifier.startsWith("@jagentdesk/plugin")) {
        const entry = specifier.replace("@jagentdesk/plugin", ".") as keyof typeof entries;
        if (
          entry === "./client/host" ||
          entry.startsWith("./internal/") ||
          !(entry in entries) ||
          (entries[entry] !== "shared" && entries[entry] !== runtime)
        )
          violations.push(specifier);
      } else if (
        (runtime !== "client" && uiDependency.test(specifier)) ||
        (runtime !== "server" && isBuiltin(specifier))
      ) {
        violations.push(specifier);
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("plugin agent tools SDK boundary", () => {
  it("lets a session hook attach typed tools without exposing their transport", () => {
    expect(
      typeErrors(`
      import { z } from "zod";
      import { defineAgentTool, type PluginServerContext, type AgentToolResult, type AgentToolContext, type AgentToolDefinition } from "@jagentdesk/plugin/server";
      const tool: AgentToolDefinition = defineAgentTool({
        name: "create_issue",
        description: "Create an issue",
        input: z.object({ title: z.string(), count: z.string().transform(Number) }),
        async execute(input, { agent, jagentdesk, signal }) {
          const count: number = input.count;
          // @ts-expect-error input is inferred from the schema
          input.missing;
          return { text: agent.id + input.title, structuredContent: { count } };
        },
      });
      export default function contribute(server: PluginServerContext) {
        server.addHook("agent.open.before", async ({ request }) => {
          const title: string | null = request.title;
          // @ts-expect-error labels are read-only
          request.labels.x = "changed";
          if (request.labels.x !== "y") return;
          // @ts-expect-error MCP servers use the same typed transport config as saved servers
          request.mcpServers.invalid = { type: "http", url: 42 };
          return { ...request, tools: [...request.tools, tool], mcpServers: {
            ...request.mcpServers, company: { type: "http", url: "https://tools.example.com/mcp" },
          } };
        });
        return () => {};
      }
    `),
    ).toEqual([]);
  });
});

describe("lifecycle hook SDK types", () => {
  it("infers payloads and replacement requests and requires async handlers and new names", () => {
    expect(
      typeErrors(`
      import type { PluginServerContext, PluginHooks, PluginHookPayload, PluginHookResult } from "@jagentdesk/plugin/server";
      export default function contribute(server: PluginServerContext) {
        server.addHook("worktree.create.after", async ({ worktree }) => {
          const path: string = worktree.path;
          const branch: string = worktree.branch;
          const source: string = worktree.sourceCheckout;
          // @ts-expect-error Worktree facts have no workspace identity.
          worktree.workspaceId;
        });
        server.addHook("workspace.create.before", async ({ request }) => ({ ...request, title: "Changed" }));
        server.addHook("workspace.create.before", async () => {});
        server.addHook("agent.open.before", async () => {});
        server.addHook("agent.turn.after", async ({ agent, outcome, timeline }, { jagentdesk, signal }) => {
          const kind: "completed" | "failed" | "canceled" = outcome.kind;
          // @ts-expect-error Notification payloads have no creation request.
          outcome.request;
        });
        // @ts-expect-error Async handlers are required even for notifications.
        server.addHook("agent.turn.before", () => {});
        // @ts-expect-error Legacy names are only accepted by deprecated registration methods.
        server.addHook("agent.session_open", async () => {});
        // @ts-expect-error Unknown names fail typechecking.
        server.addHook("nonsense", async () => {});
        // @ts-expect-error A prepare handler must return the whole request or undefined.
        server.addHook("agent.create.before", async () => ({ invalid: true }));
        server.before("agent.session_open", ({ request }) => request);
        server.on("agent.turn_ended", () => {});
        return () => {};
      }
    `),
    ).toEqual([]);
  });
});

describe("agent session reload SDK boundary", () => {
  it("exposes reload separately from snapshot refresh", () => {
    expect(
      typeErrors(`
      import { type PluginServerContext } from "@jagentdesk/plugin/server";
      import { type JAgentDeskAgentRefetchResult } from "@jagentdesk/client";
      async function reload(server: PluginServerContext, jagentdesk: import("@jagentdesk/client").JAgentDeskApi) {
        const agent = jagentdesk.agents.ref("chosen-agent");
        const read: JAgentDeskAgentRefetchResult | null = await agent.refresh("read-snapshot");
        const reopened: JAgentDeskAgentRefetchResult | null = await agent.reload({ requestId: "reload-session" });
        await agent.reload();
        // @ts-expect-error reload options can grow without a positional signature change
        await agent.reload("reload-session");
      }
    `),
    ).toEqual([]);
  });
});
