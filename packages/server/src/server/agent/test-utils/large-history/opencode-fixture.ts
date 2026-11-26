import type { SessionMessageInfo } from "@opencode/client";
import { LargeHistoryText, type LargeHistorySize } from "./synthetic-text.js";

export interface OpenCodeLargeHistory {
  messages: SessionMessageInfo[];
  expectedItems: number;
  lastAssistantText: string;
  bytes: number;
}

/**
 * Builds an OpenCode 2.x session's messages in the shapes `message.list` returns: user messages
 * and assistant messages whose content holds reasoning, text and completed tool calls.
 */
export function generateOpenCodeLargeHistory(params: {
  size: LargeHistorySize;
  cwd: string;
}): OpenCodeLargeHistory {
  const { size, cwd } = params;
  const text = new LargeHistoryText(size.seed ?? 11);
  const messages: SessionMessageInfo[] = [];
  const base = Date.parse("2026-08-01T08:00:00.000Z");
  let clock = 0;
  let expectedItems = 0;
  let lastAssistantText = "";
  const now = () => {
    clock += 1_000;
    return base + clock;
  };
  for (let turn = 0; turn < size.turns; turn++) {
    messages.push({
      id: `msg_user_${turn.toString().padStart(6, "0")}`,
      type: "user",
      text: `Turn ${turn}: ${text.sentence(size.promptChars)}`,
      time: { created: now() },
    });
    expectedItems += 1;
    const created = now();
    lastAssistantText = `Done with turn ${turn}. ${text.sentence(size.textChars)}`;
    const tools = Array.from({ length: size.toolsPerTurn }, (_, tool) => {
      const huge =
        size.hugeOutputEvery > 0 && (turn * size.toolsPerTurn + tool) % size.hugeOutputEvery === 0;
      return {
        type: "tool" as const,
        id: `call_${turn}_${tool}`,
        name: "bash",
        time: { created: now(), completed: now() },
        state: {
          status: "completed" as const,
          input: { command: `npm run test -- module-${turn}-${tool}`, description: "Run tests" },
          content: [
            {
              type: "text" as const,
              text: text.block(huge ? size.hugeOutputChars : size.toolOutputChars),
            },
          ],
          metadata: { exit: 0, cwd },
        },
      };
    });
    messages.push({
      id: `msg_assistant_${turn.toString().padStart(6, "0")}`,
      type: "assistant",
      agent: "build",
      model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
      time: { created, completed: now() },
      finish: "stop",
      content: [
        { type: "reasoning", text: text.sentence(size.thinkingChars) },
        ...tools,
        { type: "text", text: lastAssistantText },
      ],
    } as SessionMessageInfo);
    expectedItems += 2 + size.toolsPerTurn;
  }
  return {
    messages,
    expectedItems,
    lastAssistantText,
    bytes: Buffer.byteLength(JSON.stringify(messages)),
  };
}
