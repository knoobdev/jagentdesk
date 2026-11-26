import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { claudeProjectDirSync } from "../../providers/claude/project-dir.js";
import { LargeHistoryText, type LargeHistorySize } from "./synthetic-text.js";

export interface ClaudeLargeHistory {
  cwd: string;
  configDir: string;
  sessionId: string;
  transcriptPath: string;
  /** Timeline items the parent transcript replays to. */
  expectedItems: number;
  lastAssistantText: string;
}

const TOOL_NAMES = ["Read", "Bash", "Edit", "Grep", "Bash"] as const;

/**
 * Writes a Claude Code session transcript in the shape Claude Code 2.x records: one JSONL record per
 * content block, tool results echoed into `toolUseResult`, file-history snapshots and sidechain
 * subagent transcripts. Records are generated and appended one turn at a time so the generator
 * never holds the corpus.
 */
export function generateClaudeLargeHistory(params: {
  root: string;
  size: LargeHistorySize;
  sessionId?: string;
}): ClaudeLargeHistory {
  const { root, size } = params;
  const sessionId = params.sessionId ?? "00000000-0000-4000-8000-0000000c1a0d";
  const cwd = path.join(root, "repo");
  const configDir = path.join(root, "claude");
  mkdirSync(cwd, { recursive: true });
  const project = claudeProjectDirSync(cwd, { configDir });
  mkdirSync(project, { recursive: true });
  const transcriptPath = path.join(project, `${sessionId}.jsonl`);
  const subagentsDir = path.join(project, sessionId, "subagents");
  mkdirSync(subagentsDir, { recursive: true });
  writeFileSync(transcriptPath, "");

  const text = new LargeHistoryText(size.seed ?? 1);
  const base = Date.parse("2026-08-01T08:00:00.000Z");
  let clock = 0;
  let parentUuid: string | null = null;
  let uuidCounter = 0;
  let expectedItems = 0;
  let lastAssistantText = "";
  const common = {
    isSidechain: false,
    userType: "external",
    cwd,
    sessionId,
    version: "2.1.220",
    gitBranch: "main",
  };
  const nextUuid = () => {
    uuidCounter += 1;
    return `00000000-0000-4000-8000-${uuidCounter.toString(16).padStart(12, "0")}`;
  };
  const nextTimestamp = () => {
    clock += 1_500;
    return new Date(base + clock).toISOString();
  };

  for (let turn = 0; turn < size.turns; turn++) {
    const lines: string[] = [];
    const push = (record: Record<string, unknown>) => {
      const uuid = nextUuid();
      lines.push(
        JSON.stringify({ parentUuid, ...common, ...record, uuid, timestamp: nextTimestamp() }),
      );
      parentUuid = uuid;
      return uuid;
    };
    const assistant = (messageId: string, block: unknown, stopReason: string | null) =>
      push({
        type: "assistant",
        requestId: `req_${turn.toString(36)}_${messageId}`,
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          model: "claude-opus-4-5-20251101",
          content: [block],
          stop_reason: stopReason,
          stop_sequence: null,
          usage: {
            input_tokens: 6,
            cache_creation_input_tokens: 1_200,
            cache_read_input_tokens: 48_000 + turn * 40,
            output_tokens: 420,
            service_tier: "standard",
          },
        },
      });

    push({
      type: "user",
      permissionMode: "default",
      message: { role: "user", content: `Turn ${turn}: ${text.sentence(size.promptChars)}` },
    });
    expectedItems += 1;
    lines.push(
      JSON.stringify({
        type: "file-history-snapshot",
        messageId: `snapshot-${turn}`,
        snapshot: { messageId: `snapshot-${turn}`, trackedFileBackups: {}, timestamp: "x" },
        isSnapshotUpdate: false,
      }),
    );
    const messageId = `msg_${turn.toString(36).padStart(6, "0")}`;
    assistant(
      messageId,
      {
        type: "thinking",
        thinking: text.sentence(size.thinkingChars),
        signature: "sig".repeat(80),
      },
      null,
    );
    expectedItems += 1;
    assistant(messageId, { type: "text", text: text.sentence(size.textChars) }, null);
    expectedItems += 1;
    for (let tool = 0; tool < size.toolsPerTurn; tool++) {
      const name = TOOL_NAMES[tool % TOOL_NAMES.length];
      const toolUseId = `toolu_${turn.toString(36)}_${tool}`;
      // Long agents carry a few very large command outputs (real transcripts reach 1.3 MB lines).
      const huge =
        size.hugeOutputEvery > 0 && (turn * size.toolsPerTurn + tool) % size.hugeOutputEvery === 0;
      const output = text.block(huge ? size.hugeOutputChars : size.toolOutputChars);
      const filePath = path.join(cwd, "src", `module-${turn}-${tool}.ts`);
      const { input, toolUseResult } = claudeToolRecord({ name, filePath, cwd, output, text });
      const toolUseUuid = assistant(
        messageId,
        { type: "tool_use", id: toolUseId, name, input },
        "tool_use",
      );
      expectedItems += 1;
      push({
        type: "user",
        sourceToolAssistantUUID: toolUseUuid,
        message: {
          role: "user",
          content: [{ tool_use_id: toolUseId, type: "tool_result", content: output }],
        },
        toolUseResult,
      });
      // Claude Code records the request it sent next, echoing the tool result; history ignores it.
      if (huge) {
        lines.push(
          JSON.stringify({
            type: "api-request-blob",
            sessionId,
            blob: {
              messages: [{ role: "user", content: [{ type: "tool_result", content: output }] }],
            },
          }),
        );
      }
    }
    lines.push(
      JSON.stringify({ type: "queue-operation", operation: "dequeue", sessionId, timestamp: "x" }),
      JSON.stringify({ type: "last-prompt", sessionId, prompt: text.sentence(120) }),
      JSON.stringify({
        type: "attachment",
        sessionId,
        attachment: { type: "todo_reminder", content: text.sentence(size.textChars) },
      }),
    );
    if (size.imageEvery > 0 && turn % size.imageEvery === size.imageEvery - 1) {
      push({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: text.base64(350_000) },
            },
            { type: "text", text: "Here is the screenshot" },
          ],
        },
      });
      expectedItems += 1;
    }
    if (size.subagentEvery > 0 && turn % size.subagentEvery === size.subagentEvery - 1) {
      const toolUseId = `toolu_task_${turn}`;
      const agentId = `a${turn.toString(16).padStart(16, "0")}`;
      assistant(
        messageId,
        {
          type: "tool_use",
          id: toolUseId,
          name: "Task",
          input: { description: `Investigate ${turn}`, prompt: text.sentence(200) },
        },
        "tool_use",
      );
      expectedItems += 1;
      writeClaudeSubagent({ subagentsDir, agentId, toolUseId, cwd, sessionId, text, size });
      push({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              tool_use_id: toolUseId,
              type: "tool_result",
              content: [{ type: "text", text: text.sentence(400) }],
            },
          ],
        },
        toolUseResult: { status: "completed", agentId, totalDurationMs: 12_000 },
      });
    }
    lastAssistantText = `Done with turn ${turn}. ${text.sentence(size.textChars)}`;
    assistant(messageId, { type: "text", text: lastAssistantText }, "end_turn");
    expectedItems += 1;
    lines.push(
      JSON.stringify({
        parentUuid,
        ...common,
        type: "system",
        subtype: "turn_duration",
        durationMs: 42_000,
        uuid: nextUuid(),
        timestamp: nextTimestamp(),
      }),
    );
    appendFileSync(transcriptPath, `${lines.join("\n")}\n`);
  }

  return { cwd, configDir, sessionId, transcriptPath, expectedItems, lastAssistantText };
}

/** A tool call's input and the `toolUseResult` Claude Code records for it, by tool. */
function claudeToolRecord(params: {
  name: (typeof TOOL_NAMES)[number];
  filePath: string;
  cwd: string;
  output: string;
  text: LargeHistoryText;
}): { input: Record<string, unknown>; toolUseResult: Record<string, unknown> } {
  const { name, filePath, cwd, output, text } = params;
  switch (name) {
    case "Read":
      return {
        input: { file_path: filePath },
        toolUseResult: {
          type: "text",
          file: { filePath, content: output, numLines: 400, startLine: 1, totalLines: 400 },
        },
      };
    case "Edit": {
      const oldString = text.sentence(80);
      const newString = text.sentence(90);
      return {
        input: { file_path: filePath, old_string: oldString, new_string: newString },
        toolUseResult: {
          filePath,
          oldString,
          newString,
          originalFile: output,
          structuredPatch: [
            { oldStart: 10, oldLines: 1, newStart: 10, newLines: 1, lines: ["-a", "+b"] },
          ],
          userModified: false,
          replaceAll: false,
        },
      };
    }
    case "Grep":
      return {
        input: { pattern: "createSession", path: cwd, output_mode: "content" },
        toolUseResult: { stdout: output, stderr: "", interrupted: false, isImage: false },
      };
    case "Bash":
      return {
        input: { command: `npm run test -- ${path.basename(filePath)}`, description: "Run tests" },
        toolUseResult: { stdout: output, stderr: "", interrupted: false, isImage: false },
      };
  }
}

function writeClaudeSubagent(params: {
  subagentsDir: string;
  agentId: string;
  toolUseId: string;
  cwd: string;
  sessionId: string;
  text: LargeHistoryText;
  size: LargeHistorySize;
}): void {
  const { subagentsDir, agentId, toolUseId, cwd, sessionId, text, size } = params;
  const records: string[] = [];
  let parentUuid: string | null = null;
  for (let index = 0; index < 12; index++) {
    const uuid = `${agentId}-${index}`;
    const common = { parentUuid, isSidechain: true, agentId, cwd, sessionId, uuid };
    const timestamp = new Date(Date.parse("2026-08-01T08:00:00.000Z") + index * 1000).toISOString();
    records.push(
      JSON.stringify(
        index === 0
          ? { ...common, type: "user", timestamp, message: { role: "user", content: "Go" } }
          : {
              ...common,
              type: "assistant",
              timestamp,
              message: {
                id: `msg_${agentId}_${index}`,
                role: "assistant",
                content: [{ type: "text", text: text.sentence(size.toolOutputChars / 4) }],
                stop_reason: index === 11 ? "end_turn" : null,
              },
            },
      ),
    );
    parentUuid = uuid;
  }
  writeFileSync(path.join(subagentsDir, `agent-${agentId}.jsonl`), `${records.join("\n")}\n`);
  writeFileSync(
    path.join(subagentsDir, `agent-${agentId}.meta.json`),
    JSON.stringify({ toolUseId, agentType: "general-purpose" }),
  );
}
