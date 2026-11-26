import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LargeHistoryText, type LargeHistorySize } from "./synthetic-text.js";

export interface CodexLargeHistory {
  cwd: string;
  codexHome: string;
  threadId: string;
  rolloutPath: string;
  expectedItems: number;
  lastAssistantText: string;
}

/**
 * Writes a Codex rollout in the shape Codex CLI records: `session_meta`, a `turn_context` per turn,
 * `response_item`s for the model's input and output, and the `event_msg`s app-server rebuilds
 * thread turns from. This is the legacy (unpaginated) rollout a months-old thread has: command
 * runs are not persisted as events there, so the bulk of the file is `function_call_output`s
 * Codex must read past, and the replayed tools are the `patch_apply_end` file changes. Generated one turn at a time so the generator never holds the corpus.
 */
export function generateCodexLargeHistory(params: {
  root: string;
  size: LargeHistorySize;
  threadId?: string;
  cliVersion?: string;
}): CodexLargeHistory {
  const { root, size } = params;
  const threadId = params.threadId ?? "019a0000-0000-7000-8000-00000000c0de";
  const cliVersion = params.cliVersion ?? "0.165.0";
  const cwd = path.join(root, "repo");
  const codexHome = path.join(root, "codex");
  mkdirSync(cwd, { recursive: true });
  const day = path.join(codexHome, "sessions", "2026", "08", "01");
  mkdirSync(day, { recursive: true });
  writeFileSync(path.join(codexHome, "config.toml"), 'model = "gpt-5.1-codex"\n');
  const rolloutPath = path.join(day, `rollout-2026-08-01T08-00-00-${threadId}.jsonl`);
  const text = new LargeHistoryText(size.seed ?? 7);
  const base = Date.parse("2026-08-01T08:00:00.000Z");
  let clock = 0;
  let expectedItems = 0;
  let lastAssistantText = "";
  const stamp = () => {
    clock += 1_200;
    return new Date(base + clock).toISOString();
  };
  const line = (type: string, payload: Record<string, unknown>) =>
    JSON.stringify({ timestamp: stamp(), type, payload });

  writeFileSync(
    rolloutPath,
    `${line("session_meta", {
      id: threadId,
      session_id: threadId,
      timestamp: new Date(base).toISOString(),
      cwd,
      originator: "codex_cli_rs",
      cli_version: cliVersion,
      source: "cli",
      model_provider: "openai",
      base_instructions: { text: "You are Codex." },
    })}\n`,
  );

  for (let turn = 0; turn < size.turns; turn++) {
    const lines: string[] = [];
    const turnId = `turn-${turn}`;
    const prompt = `Turn ${turn}: ${text.sentence(size.promptChars)}`;
    lines.push(
      line("event_msg", { type: "task_started", turn_id: turnId, model_context_window: 272_000 }),
    );
    lines.push(
      line("turn_context", {
        turn_id: turnId,
        cwd,
        approval_policy: "on-request",
        sandbox_policy: { type: "workspace-write", network_access: false },
        model: "gpt-5.1-codex",
        effort: "medium",
        summary: "auto",
      }),
    );
    lines.push(
      line("response_item", {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: prompt }],
      }),
    );
    lines.push(line("event_msg", { type: "user_message", message: prompt, images: [] }));
    expectedItems += 1;
    const reasoning = text.sentence(size.thinkingChars);
    lines.push(line("event_msg", { type: "agent_reasoning", text: reasoning }));
    lines.push(
      line("response_item", {
        type: "reasoning",
        summary: [{ type: "summary_text", text: reasoning }],
        content: null,
        encrypted_content: "gAAAA".repeat(60),
      }),
    );
    expectedItems += 1;
    for (let tool = 0; tool < size.toolsPerTurn; tool++) {
      const callId = `call_${turn}_${tool}`;
      const huge =
        size.hugeOutputEvery > 0 && (turn * size.toolsPerTurn + tool) % size.hugeOutputEvery === 0;
      const output = text.block(huge ? size.hugeOutputChars : size.toolOutputChars);
      const command = ["/bin/zsh", "-lc", `npm run test -- module-${turn}-${tool}`];
      lines.push(
        line("response_item", {
          type: "function_call",
          name: "shell_command",
          arguments: JSON.stringify({ command: command[2], workdir: cwd }),
          call_id: callId,
        }),
      );
      const filePath = path.join(cwd, "src", `module-${turn}-${tool}.ts`);
      lines.push(
        line("event_msg", {
          type: "patch_apply_end",
          call_id: callId,
          turn_id: turnId,
          stdout: `Success. Updated the following files:\nM ${filePath}\n`,
          stderr: "",
          success: true,
          changes: {
            [filePath]: {
              type: "update",
              unified_diff: `@@ -1,3 +1,3 @@\n-${text.sentence(70)}\n+${text.sentence(70)}\n`,
              move_path: null,
            },
          },
          status: "completed",
        }),
      );
      lines.push(
        line("response_item", {
          type: "function_call_output",
          call_id: callId,
          output: `Exit code: 0\nWall time: 1 seconds\nOutput:\n${output}`,
        }),
      );
      expectedItems += 1;
    }
    lastAssistantText = `Done with turn ${turn}. ${text.sentence(size.textChars)}`;
    lines.push(
      line("response_item", {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: lastAssistantText }],
      }),
    );
    lines.push(line("event_msg", { type: "agent_message", message: lastAssistantText }));
    expectedItems += 1;
    lines.push(
      line("event_msg", {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 40_000 + turn * 300,
            cached_input_tokens: 30_000,
            output_tokens: 900,
            reasoning_output_tokens: 300,
            total_tokens: 41_000 + turn * 300,
          },
          last_token_usage: {
            input_tokens: 40_000,
            cached_input_tokens: 30_000,
            output_tokens: 900,
            reasoning_output_tokens: 300,
            total_tokens: 41_000,
          },
          model_context_window: 272_000,
        },
        rate_limits: null,
      }),
    );
    lines.push(
      line("event_msg", {
        type: "task_complete",
        turn_id: turnId,
        last_agent_message: lastAssistantText,
      }),
    );
    appendFileSync(rolloutPath, `${lines.join("\n")}\n`);
  }
  return { cwd, codexHome, threadId, rolloutPath, expectedItems, lastAssistantText };
}
