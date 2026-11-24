import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentPromptInput,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../../agent/agent-sdk-types.js";
import { createTestAgentClient } from "../../test-utils/fake-agent-client.js";

// Deterministic provider adapter; all tool calls, permissions, ORC, git, storage and transport
// remain production implementations. Only the model's decisions are scripted.
export function createBotsTestProvider() {
  const base = createTestAgentClient("claude");
  const created: { config: AgentSessionConfig; launch: AgentLaunchContext | undefined }[] = [];
  const workerGates = new Map<string, () => void>();
  let unsafe = false;
  const original = base.createSession.bind(base);
  const fetchCatalog = base.fetchCatalog.bind(base);
  base.fetchCatalog = async (...args) => {
    const result = await fetchCatalog(...args);
    return {
      ...result,
      modes: result.modes?.map((mode) =>
        Object.assign({}, mode, { isUnattended: mode.id === "bypassPermissions" }),
      ),
    };
  };
  base.isCreateConfigUnattended = (input) => input.modeId === "bypassPermissions";
  base.capabilities.supportsNativeJAgentDeskTools = true;
  base.createSession = async (config, launch, options) => {
    const session = await original(config, launch, options);
    created.push({ config, launch });
    const subscribers = new Set<(event: AgentStreamEvent) => void>();
    const emit = (event: AgentStreamEvent) => {
      for (const cb of subscribers) cb(event);
    };
    let turnId = "";
    session.subscribe = (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    };
    session.startTurn = async (prompt: AgentPromptInput) => {
      turnId = randomUUID();
      const current = turnId;
      const text = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
      let role = "supervisor";
      if (config.title?.includes("Bot review")) role = config.title.split("·").at(-1)?.trim() ?? "";
      else if (config.title?.includes("Bot worker")) role = "worker";
      // A macrotask models async inference and lets AgentManager settle run admission.
      setTimeout(() => {
        void (async () => {
          let answer = "Available for another question.";
          if (role === "supervisor" && text.includes("[chat]\nfix sum")) {
            const catalog = launch?.jagentdeskTools;
            if (!catalog) throw new Error("Missing bot catalog");
            const add = await catalog.executeTool("bot_item_add", {
              title: "Fix sum",
              doneMeans: "node --test passes; no eval",
            });
            if (add.isError) throw new Error(JSON.stringify(add));
            const item = JSON.parse(add.content[0].text!) as { id: string };
            const start = await catalog.executeTool("bot_worker_start", {
              itemId: item.id,
              assignment: unsafe
                ? "Use eval first to exercise security review"
                : "Fix sum.js and test",
            });
            if (start.isError) throw new Error(JSON.stringify(start));
            answer = "Worker dispatched. I am available for other questions.";
          } else if (role === "worker") {
            if (!text.includes("Fix round"))
              await new Promise<void>((resolve) => {
                workerGates.set(config.cwd, resolve);
              });
            const bad = unsafe && !text.includes("Fix round");
            await writeFile(
              join(config.cwd, "sum.js"),
              bad
                ? "export const sum = (a,b) => eval(a + '+' + b);\n"
                : "export const sum = (a,b) => a + b;\n",
            );
            if (!bad) await promisify(execFile)(process.execPath, ["--test"], { cwd: config.cwd });
            answer = bad
              ? "Used eval; changed sum.js."
              : "Fixed addition. node --test passes. Diff: sum.js returns a + b.";
          } else if (["ba", "tester", "pentester"].includes(role ?? "")) {
            const code = await readFile(join(config.cwd, "sum.js"), "utf8");
            const findings =
              role === "pentester" && code.includes("eval")
                ? [
                    {
                      path: "sum.js",
                      startLine: 1,
                      endLine: 1,
                      category: "security",
                      severity: "high",
                      content: "eval executes user input",
                      suggestion: "Use numeric addition",
                    },
                  ]
                : [];
            answer = JSON.stringify({ findings, coverage: "sum.js and sum.test.js" });
          }
          emit({
            type: "timeline",
            provider: "claude",
            turnId: current,
            item: { type: "assistant_message", text: answer },
          });
          emit({ type: "turn_completed", provider: "claude", turnId: current });
        })().catch((err) =>
          emit({ type: "turn_failed", provider: "claude", turnId: current, error: String(err) }),
        );
      }, 0);
      return { turnId: current };
    };
    session.interrupt = async () => {
      emit({ type: "turn_canceled", provider: "claude", turnId, reason: "interrupted" });
    };
    return session;
  };
  return {
    client: base as AgentClient,
    created,
    workerGates,
    setUnsafe: (value: boolean) => {
      unsafe = value;
    },
  };
}
