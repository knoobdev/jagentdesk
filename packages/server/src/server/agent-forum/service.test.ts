import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import pino from "pino";
import { AgentForumService } from "./service.js";

// Unit coverage for the task lifecycle + derived topic status (docs/plans/active/agent-forum.md).
// This is the logic the forum.* agent tools drive; testing it directly avoids needing a live agent.

describe("AgentForumService", () => {
  let dir: string;
  let service: AgentForumService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "jad-forum-svc-"));
    service = new AgentForumService({ dir, logger: pino({ level: "silent" }) });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("topic + task lifecycle drives the derived status and audit trail", async () => {
    const topic = await service.createTopic({ prompt: "Build a todo app" });
    expect(topic.status).toBe("discussion"); // no tasks yet — still discussing
    expect(topic.messages).toHaveLength(1); // origin prompt seeded

    // Create a task → topic moves to in_progress (has active work).
    const withTask = await service.createTask(topic.id, {
      title: "Scaffold app",
      createdBy: "lead1",
    });
    const taskId = withTask!.tasks[0]!.id;
    expect(withTask!.status).toBe("building");
    expect(withTask!.tasks[0]!.status).toBe("backlog");

    // A subtask references its parent.
    const withSub = await service.createTask(topic.id, {
      title: "Set up bundler",
      createdBy: "lead1",
      parentTaskId: taskId,
    });
    expect(withSub!.tasks.some((t) => t.parentTaskId === taskId)).toBe(true);

    // Assign + estimate record history events.
    await service.assignTask(topic.id, taskId, "peer1", "lead1");
    const estimated = await service.estimateTask(topic.id, taskId, "m", "lead1");
    const task = estimated!.tasks.find((t) => t.id === taskId)!;
    expect(task.assigneeAgentId).toBe("peer1");
    expect(task.estimate).toBe("m");
    expect(task.history.map((h) => h.kind)).toEqual(["created", "assigned", "estimated"]);

    // Idempotent: re-estimating to the same value adds no event.
    const again = await service.estimateTask(topic.id, taskId, "m", "lead1");
    expect(again!.tasks.find((t) => t.id === taskId)!.history).toHaveLength(3);

    // Move both tasks to review → derived topic status is review (no active tasks left).
    for (const t of again!.tasks) await service.setTaskStatus(topic.id, t.id, "review", "peer1");
    const inReview = await service.getTopic(topic.id);
    expect(inReview!.status).toBe("review");

    // Finish both → done.
    for (const t of inReview!.tasks) await service.setTaskStatus(topic.id, t.id, "done", "peer1");
    const done = await service.getTopic(topic.id);
    expect(done!.status).toBe("done");

    // Archive wins over derivation.
    const archived = await service.archiveTopic(topic.id);
    expect(archived!.status).toBe("archived");
    const stillArchived = await service.createTask(topic.id, { title: "late", createdBy: "lead1" });
    expect(stillArchived!.status).toBe("archived");
  });

  test("appendMessage registers the author as a participant once", async () => {
    const topic = await service.createTopic({ prompt: "hi" });
    await service.appendMessage(topic.id, {
      authorAgentId: "lead1",
      authorLabel: "Lead 1",
      role: "lead",
      text: "here is my plan",
      kind: "proposal",
    });
    const after = await service.appendMessage(topic.id, {
      authorAgentId: "lead1",
      authorLabel: "Lead 1",
      role: "lead",
      text: "update",
    });
    expect(after!.participants.filter((p) => p.agentId === "lead1")).toHaveLength(1);
    expect(after!.messages.at(-1)!.text).toBe("update");
  });

  test("phase transitions + role review (BA/Tester/Pentester)", async () => {
    const topic = await service.createTopic({ prompt: "Build a thing" });
    // Lead advances discussion → planning explicitly.
    const planning = await service.setPhase(topic.id, "planning");
    expect(planning!.status).toBe("planning");

    const withTask = await service.createTask(topic.id, { title: "Do X", createdBy: "lead1" });
    const taskId = withTask!.tasks[0]!.id;
    await service.setTaskStatus(topic.id, taskId, "review", "coder1");

    // Pentester requests changes → task returns to in_progress and the finding is posted.
    const changed = await service.reviewTask(topic.id, {
      taskId,
      role: "pentester",
      reviewerAgentId: "pen1",
      reviewerLabel: "Pentester 1",
      verdict: "request_changes",
      findings: [
        {
          path: "src/render.ts",
          startLine: 42,
          endLine: 44,
          category: "security",
          severity: "high",
          content: "XSS via innerHTML with untrusted input",
          suggestion: "Use textContent or sanitize",
        },
      ],
    });
    expect(changed!.tasks[0]!.status).toBe("in_progress");
    const review = changed!.messages.at(-1)!;
    expect(review.role).toBe("pentester");
    expect(review.kind).toBe("review");
    expect(review.text).toContain("XSS");
    expect(changed!.participants.some((p) => p.role === "pentester")).toBe(true);

    // Re-review: the task is done only when ALL required roles (ba/tester/pentester) approve.
    await service.setTaskStatus(topic.id, taskId, "review", "coder1");
    await service.reviewTask(topic.id, {
      taskId,
      role: "ba",
      reviewerAgentId: "ba1",
      reviewerLabel: "BA 1",
      verdict: "approve",
      findings: [],
    });
    await service.reviewTask(topic.id, {
      taskId,
      role: "tester",
      reviewerAgentId: "qa1",
      reviewerLabel: "Tester 1",
      verdict: "approve",
      findings: [],
    });
    // Pentester's latest verdict is still request_changes → task stays in_progress, not done.
    const partial = await service.getTopic(topic.id);
    expect(partial!.tasks[0]!.status).toBe("in_progress");
    // Pentester (who requested changes) now approves → all three approved → done.
    const approved = await service.reviewTask(topic.id, {
      taskId,
      role: "pentester",
      reviewerAgentId: "pen1",
      reviewerLabel: "Pentester 1",
      verdict: "approve",
      findings: [],
    });
    expect(approved!.tasks[0]!.status).toBe("done");
    expect(approved!.status).toBe("done");
  });

  test("createBootstrapTopic dedupes near-duplicate forum/create for the same lead", async () => {
    // A double-fired forum/create (Enter + keyboard send, or a draft handoff replay) must not mint two
    // teams: reuse the same topic and report created:false so the caller skips a second lead bootstrap.
    const first = await service.createBootstrapTopic({
      prompt: "Build a weather card",
      leadAgentId: "agent_lead1",
    });
    expect(first.created).toBe(true);
    const second = await service.createBootstrapTopic({
      prompt: "Build a weather card",
      leadAgentId: "agent_lead1",
    });
    expect(second.created).toBe(false);
    expect(second.topic.id).toBe(first.topic.id);
    // Only one topic exists.
    expect(await service.listSummaries()).toHaveLength(1);
  });

  test("createBootstrapTopic dedupes concurrent calls for the same lead (race-safe)", async () => {
    const [a, b] = await Promise.all([
      service.createBootstrapTopic({ prompt: "Ship it", leadAgentId: "agent_lead2" }),
      service.createBootstrapTopic({ prompt: "Ship it", leadAgentId: "agent_lead2" }),
    ]);
    expect(a.topic.id).toBe(b.topic.id);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1); // exactly one bootstrap
    expect(await service.listSummaries()).toHaveLength(1);
  });

  test("createBootstrapTopic keeps distinct leads independent", async () => {
    const a = await service.createBootstrapTopic({ prompt: "A", leadAgentId: "agent_a" });
    const b = await service.createBootstrapTopic({ prompt: "B", leadAgentId: "agent_b" });
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.topic.id).not.toBe(b.topic.id);
    expect(await service.listSummaries()).toHaveLength(2);
  });
});
