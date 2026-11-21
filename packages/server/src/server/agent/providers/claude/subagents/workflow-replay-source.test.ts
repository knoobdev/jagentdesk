import { expect, it } from "vitest";
import { observeReplayWorkflows } from "./workflow-replay-source.js";

it("skips parent history when there are no workflow summaries", async () => {
  const entries = {
    [Symbol.iterator](): Iterator<ClaudeWorkflowParentEntry> {
      throw new Error("parent history must not be read");
    },
  };
  await expect(observeReplayWorkflows({ workflows: [], parentEntries: entries })).resolves.toEqual(
    [],
  );
});

it("links workflow results from a single traversal, including results before their calls", async () => {
  const [call, result] = parentEntries();
  const entries = (async function* () {
    yield result!;
    yield call!;
  })();
  const observations = await observeReplayWorkflows({
    workflows: [{ runId: RUN_ID, status: "completed" }],
    parentEntries: entries,
  });
  expect(observations).toEqual([
    { kind: "declared", id: TOOL_CALL_ID, toolCallId: TOOL_CALL_ID, title: "Workflow" },
    { kind: "subtitle", id: TOOL_CALL_ID, subtitle: "Workflow" },
    { kind: "status", id: TOOL_CALL_ID, status: "completed" },
  ]);
});
