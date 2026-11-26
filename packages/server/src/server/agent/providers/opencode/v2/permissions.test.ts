import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../../../test-utils/test-logger.js";
import type { V2Api } from "./api.js";
import { OpenCodeV2AgentClient } from "./agent.js";
import { V2Harness } from "../test-utils/v2-harness.js";
import type { AgentPermissionResponse, AgentStreamEvent } from "../../../agent-sdk-types.js";
import { PermissionNotPendingError } from "../../../permission-not-pending-error.js";
import { OpenCodeHttpError } from "../http-error.js";

describe("OpenCode v2 denial reasons", () => {
  test.each<{
    response: AgentPermissionResponse;
    decision: "reject" | "once" | "always";
    message?: string;
  }>([
    {
      response: { behavior: "deny", message: "Use the existing file instead." },
      decision: "reject",
      message: "Use the existing file instead.",
    },
    { response: { behavior: "deny" }, decision: "reject" },
    { response: { behavior: "allow" }, decision: "once" },
    { response: { behavior: "allow", selectedActionId: "always" }, decision: "always" },
  ])("preserves a permission response: $response", async ({ response, decision, message }) => {
    const harness = new V2Harness();
    let pending = true;
    harness.api.permission.list = async () =>
      pending
        ? [{ id: "approval", sessionID: "session", action: "shell", resources: ["pwd"] }]
        : [];
    const replies: Parameters<V2Api["permission"]["reply"]>[0][] = [];
    harness.api.permission.reply = async (input) => {
      replies.push(input);
      pending = false;
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      await session.respondToPermission("approval", response);
      expect(replies).toEqual([
        {
          sessionID: "session",
          requestID: "approval",
          decision,
          ...(message === undefined ? {} : { message }),
        },
      ]);
      expect(session.getPendingPermissions()).toEqual([]);
    } finally {
      await session.close();
    }
  });

  test.each([true, false])(
    "explains cards superseded by a steer when clearing is %s",
    async (clearPendingPermissions) => {
      const harness = new V2Harness();
      harness.autoComplete = false;
      let pending = true;
      harness.api.permission.list = async () =>
        pending
          ? [{ id: "approval", sessionID: "session", action: "shell", resources: ["pwd"] }]
          : [];
      const replies: Parameters<V2Api["permission"]["reply"]>[0][] = [];
      harness.api.permission.reply = async (input) => {
        replies.push(input);
        pending = false;
      };
      const client = new OpenCodeV2AgentClient({
        logger: createTestLogger(),
        runtime: harness.runtime,
      });
      const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
      try {
        const { turnId } = await session.startTurn("Run pwd");
        await expect.poll(() => harness.prompts).toEqual(["Run pwd"]);
        await expect(
          session.steerActiveTurn!("go ahead", { expectedTurnId: turnId, clearPendingPermissions }),
        ).resolves.toEqual({ status: "accepted" });
        expect(harness.prompts).toEqual(["Run pwd", "go ahead"]);
        expect(replies).toEqual(
          clearPendingPermissions
            ? [
                {
                  sessionID: "session",
                  requestID: "approval",
                  decision: "reject",
                  message:
                    "The user answered with a message instead of approving. Their message follows.",
                },
              ]
            : [],
        );
        expect(session.getPendingPermissions()).toHaveLength(clearPendingPermissions ? 0 : 1);
      } finally {
        await session.close();
      }
    },
  );
});

describe("OpenCode v2 questions", () => {
  test("maps selected labels to native values and parses numeric and boolean answers", async () => {
    const harness = new V2Harness();
    harness.api.session.form.list = async () => [
      {
        id: "question",
        sessionID: "session",
        title: "Preferences",
        fields: [
          { key: "color", type: "string", options: [{ label: "Blue", value: "blue-id" }] },
          {
            key: "features",
            type: "multiselect",
            options: [{ label: "Search", value: "search-id" }],
          },
          { key: "count", type: "integer" },
          { key: "enabled", type: "boolean" },
        ],
      },
    ];
    const answers: Parameters<V2Api["session"]["form"]["reply"]>[0][] = [];
    harness.api.session.form.reply = async (input) => {
      answers.push(input);
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      expect(session.getPendingPermissions()).toHaveLength(1);
      await session.respondToPermission("question", {
        behavior: "allow",
        updatedInput: {
          answers: {
            color: "Blue",
            features: ["Search"],
            count: "3",
            enabled: "false",
          },
        },
      });
      expect(answers).toEqual([
        {
          sessionID: "session",
          formID: "question",
          answer: {
            color: "blue-id",
            features: ["search-id"],
            count: 3,
            enabled: false,
          },
        },
      ]);
      expect(session.getPendingPermissions()).toHaveLength(0);
    } finally {
      await session.close();
    }
  });
});

describe("OpenCode v2 question tool", () => {
  test("shows the question text and accepts a typed answer", async () => {
    const harness = new V2Harness();
    harness.api.session.form.list = async () => [
      {
        id: "question",
        sessionID: "session",
        title: "Questions",
        fields: [
          {
            key: "q0",
            title: "Next task",
            description: "What would you like me to work on next?",
            type: "string",
            options: [
              { value: "Explore", label: "Explore", description: "Map the codebase" },
              { value: "Fix a bug", label: "Fix a bug", description: "Track down a bug" },
            ],
            custom: true,
          },
        ],
      },
    ];
    const answers: Parameters<V2Api["session"]["form"]["reply"]>[0][] = [];
    harness.api.session.form.reply = async (input) => {
      answers.push(input);
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      const [request] = session.getPendingPermissions();
      expect(request.input).toEqual({
        questions: [
          {
            header: "Next task",
            question: "What would you like me to work on next?",
            options: [
              { value: "Explore", label: "Explore", description: "Map the codebase" },
              { value: "Fix a bug", label: "Fix a bug", description: "Track down a bug" },
            ],
            multiSelect: false,
            allowOther: true,
          },
        ],
      });
      await session.respondToPermission("question", {
        behavior: "allow",
        updatedInput: { answers: { "Next task": "Write the release notes" } },
      });
      expect(answers).toEqual([
        {
          sessionID: "session",
          formID: "question",
          answer: { q0: "Write the release notes" },
        },
      ]);
    } finally {
      await session.close();
    }
  });

  test("answers a multi-select question with the checked options and a typed answer", async () => {
    const harness = new V2Harness();
    harness.api.session.form.list = async () => [
      {
        id: "question",
        sessionID: "session",
        title: "Questions",
        fields: [
          {
            key: "q0",
            title: "Fixes",
            description: "Which fixes should I make?",
            type: "multiselect",
            options: [
              { value: "delete", label: "Delete both" },
              { value: "delete-and-fix", label: "Delete both, fix code" },
              { value: "email", label: "Email the user" },
            ],
            custom: true,
          },
        ],
      },
    ];
    const answers: Parameters<V2Api["session"]["form"]["reply"]>[0][] = [];
    harness.api.session.form.reply = async (input) => {
      answers.push(input);
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      const [request] = session.getPendingPermissions();
      expect(request.input).toMatchObject({ questions: [{ header: "Fixes", multiSelect: true }] });
      await session.respondToPermission("question", {
        behavior: "allow",
        updatedInput: {
          answers: { Fixes: "Delete both, fix code, Email the user, Also check the logs" },
        },
      });
      expect(answers).toEqual([
        {
          sessionID: "session",
          formID: "question",
          answer: { q0: ["delete-and-fix", "email", "Also check the logs"] },
        },
      ]);
      expect(session.getPendingPermissions()).toHaveLength(0);
    } finally {
      await session.close();
    }
  });

  test("rejects typed text on a multi-select question that has no typed answer", async () => {
    const harness = new V2Harness();
    harness.api.session.form.list = async () => [
      {
        id: "question",
        sessionID: "session",
        title: "Questions",
        fields: [
          {
            key: "q0",
            title: "Fixes",
            type: "multiselect",
            options: [{ value: "delete", label: "Delete both" }],
          },
        ],
      },
    ];
    const answers: Parameters<V2Api["session"]["form"]["reply"]>[0][] = [];
    harness.api.session.form.reply = async (input) => {
      answers.push(input);
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      await expect(
        session.respondToPermission("question", {
          behavior: "allow",
          updatedInput: { answers: { Fixes: "Delete both, Something else" } },
        }),
      ).rejects.toThrow("Invalid answer for OpenCode question q0");
      expect(answers).toEqual([]);
    } finally {
      await session.close();
    }
  });
});

describe("OpenCode v2 permission routing", () => {
  test("routes a child approval back to its owning session", async () => {
    const harness = new V2Harness();
    const child = { ...harness.info, id: "child", parentID: "session" };
    harness.api.session.list = async (input) => ({
      data: input?.parentID === "session" ? [child] : [],
      cursor: {},
    });
    harness.api.permission.list = async (input) =>
      input.sessionID === "child"
        ? [{ id: "child-permission", sessionID: "child", action: "shell", resources: ["pwd"] }]
        : [];
    const replies: Parameters<V2Api["permission"]["reply"]>[0][] = [];
    harness.api.permission.reply = async (input) => {
      replies.push(input);
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      expect(session.getPendingPermissions()).toHaveLength(1);
      await session.respondToPermission("child-permission", {
        behavior: "allow",
        selectedActionId: "once",
      });
      expect(replies).toEqual([
        { sessionID: "child", requestID: "child-permission", decision: "once" },
      ]);
    } finally {
      await session.close();
    }
  });

  test("clears an approval resolved by another native client", async () => {
    const harness = new V2Harness();
    harness.api.permission.list = async () => [
      { id: "approval", sessionID: "session", action: "shell", resources: ["pwd"] },
    ];
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      expect(session.getPendingPermissions()).toHaveLength(1);
      harness.api.permission.list = async () => [];
      harness.push({
        id: "resolved",
        created: 2,
        type: "permission.replied",
        data: { sessionID: "session", requestID: "approval", reply: "once" },
      });
      await expect.poll(() => session.getPendingPermissions()).toEqual([]);
    } finally {
      await session.close();
    }
  });
});

describe("OpenCode v2 permissions OpenCode no longer has", () => {
  async function pendingExternalDirectory(harness: V2Harness) {
    let listed = true;
    harness.api.permission.list = async () =>
      listed
        ? [
            {
              id: "per_external",
              sessionID: "session",
              action: "external_directory",
              resources: ["/private/var/folders/T/opencode/*"],
              save: ["/private/var/folders/T/opencode/*"],
            },
          ]
        : [];
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    return {
      session,
      events,
      forget: () => {
        listed = false;
      },
    };
  }

  test("a reply OpenCode answers with 404 drops the card as expired", async () => {
    const harness = new V2Harness();
    const { session, events } = await pendingExternalDirectory(harness);
    harness.api.permission.reply = async (input) => {
      throw new OpenCodeHttpError(
        `/api/session/${input.sessionID}/permission/${input.requestID}/reply`,
        404,
        false,
      );
    };
    try {
      expect(session.getPendingPermissions().map((request) => request.id)).toEqual([
        "per_external",
      ]);
      await expect(
        session.respondToPermission("per_external", {
          behavior: "allow",
          selectedActionId: "once",
        }),
      ).rejects.toBeInstanceOf(PermissionNotPendingError);
      expect(session.getPendingPermissions()).toEqual([]);
      expect(events).toContainEqual({
        type: "permission_resolved",
        provider: "opencode",
        requestId: "per_external",
        resolution: { behavior: "deny", message: "This request is no longer pending" },
        expired: true,
      });
    } finally {
      await session.close();
    }
  });

  test("other reply failures keep the card answerable", async () => {
    const harness = new V2Harness();
    const { session } = await pendingExternalDirectory(harness);
    harness.api.permission.reply = async () => {
      throw new OpenCodeHttpError("/api/session/session/permission/per_external/reply", 500, false);
    };
    try {
      await expect(
        session.respondToPermission("per_external", { behavior: "allow" }),
      ).rejects.toBeInstanceOf(OpenCodeHttpError);
      expect(session.getPendingPermissions().map((request) => request.id)).toEqual([
        "per_external",
      ]);
    } finally {
      await session.close();
    }
  });

  test("a reconnect to a restarted server drops cards it no longer lists", async () => {
    const harness = new V2Harness();
    const { session, events, forget } = await pendingExternalDirectory(harness);
    try {
      expect(session.getPendingPermissions()).toHaveLength(1);
      forget();
      harness.push({ id: "reconnect", created: 3, type: "server.connected", data: {} });
      await expect.poll(() => session.getPendingPermissions()).toEqual([]);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "permission_resolved",
          requestId: "per_external",
          expired: true,
        }),
      );
    } finally {
      await session.close();
    }
  });

  test("an external_directory card shows the directory patterns it asks for", async () => {
    const harness = new V2Harness();
    const { session } = await pendingExternalDirectory(harness);
    try {
      const [request] = session.getPendingPermissions();
      expect(request).toMatchObject({
        name: "external_directory",
        title: "Access external directory",
        input: {
          action: "external_directory",
          resources: ["/private/var/folders/T/opencode/*"],
        },
        detail: { type: "plain_text", text: "/private/var/folders/T/opencode/*" },
      });
    } finally {
      await session.close();
    }
  });
});
