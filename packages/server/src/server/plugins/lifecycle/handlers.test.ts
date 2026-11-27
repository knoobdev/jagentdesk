import { expect, test } from "vitest";
import { createJAgentDeskApi } from "@jagentdesk/client";
import { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import { validateBeforeResult, PluginHookHandlers } from "./index.js";

const jagentdesk = createJAgentDeskApi(
  new DaemonClient({ url: "ws://127.0.0.1:1/ws", clientId: "lifecycle-unit" }),
);

test("removing an old registration twice preserves a newer registration for the same hook", async () => {
  const hooks = new PluginHookHandlers(() => {});
  const remove = hooks.addHook("workspace.create.before", async ({ request }) => {
    return { ...request, title: "old" };
  });
  remove();
  hooks.addHook("workspace.create.before", async ({ request }) => {
    return { ...request, title: "new" };
  });
  remove();
  const output = await hooks.invoke(
    "operation",
    "workspace.create.before",
    {
      source: { kind: "directory", path: "/project" },
    },
    jagentdesk,
  );
  expect(output).toEqual({ source: { kind: "directory", path: "/project" }, title: "new" });
});

test("before hooks compose returned requests and preserve the original input", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.addHook("workspace.create.before", async ({ request }) => {
    return { ...request, title: "first" };
  });
  hooks.addHook("workspace.create.before", async () => {
    return;
  });
  hooks.addHook("workspace.create.before", async ({ request }) => {
    return { ...request, title: request.title + ":second" };
  });
  const input = { source: { kind: "directory", path: "/project" } };
  expect(await hooks.invoke("operation", "workspace.create.before", input, jagentdesk)).toEqual({
    source: { kind: "directory", path: "/project" },
    title: "first:second",
  });
  expect(input).toEqual({ source: { kind: "directory", path: "/project" } });
});

test("teardown aborts an active callback and removes its registrations", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.addHook("workspace.create.before", async (_input, context) => {
    await new Promise<void>((_resolve, reject) => {
      context.signal.addEventListener(
        "abort",
        () => {
          reject(new Error("Hook aborted"));
        },
        { once: true },
      );
    });
  });
  const invocation = hooks.invoke(
    "operation",
    "workspace.create.before",
    {
      source: { kind: "directory", path: "/project" },
    },
    jagentdesk,
  );
  hooks.close();
  await expect(invocation).rejects.toThrow("Hook aborted");
  expect(hooks.catalog()).toEqual([]);
});

test("session-open hooks reject changes to session identity instead of silently ignoring them", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.addHook("agent.open.before", async ({ request }) => {
    return { ...request, provider: "another-provider" };
  });
  await expect(
    hooks.invoke(
      "operation",
      "agent.open.before",
      {
        agentId: "agent",
        workspaceId: "workspace",
        provider: "claude",
        cwd: "/project",
        reason: "resume",
        purpose: "interactive",
        env: {},
        title: null,
        labels: {},
        tools: [],
        mcpServers: {},
      },
      jagentdesk,
    ),
  ).rejects.toThrow("agent.open.before hooks can only change env");
});

test.each([{ title: "Changed" }, { labels: { changed: "true" } }])(
  "session-open targeting metadata is read-only: %j",
  async (patch) => {
    const hooks = new PluginHookHandlers(() => {});
    hooks.addHook("agent.open.before", async ({ request }) => ({ ...request, ...patch }));
    await expect(
      hooks.invoke(
        "operation",
        "agent.open.before",
        {
          agentId: "agent",
          workspaceId: null,
          provider: "codex",
          cwd: "/project",
          title: "Original",
          labels: {},
          tools: [],
          mcpServers: {},
          env: {},
          reason: "create",
          purpose: "interactive",
        },
        jagentdesk,
      ),
    ).rejects.toThrow(
      "agent.open.before hooks can only change env, tools, mcpServers, appendSystemPrompt, and wrap",
    );
  },
);

test("new request-changing registrations compose with legacy registrations in registration order", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.before("workspace.create", ({ request }) => ({ ...request, title: "legacy" }));
  hooks.addHook("workspace.create.before", async ({ request }) => ({
    ...request,
    title: request.title + ":new",
  }));
  hooks.before("workspace.create", ({ request }) => ({
    ...request,
    title: request.title + ":last",
  }));
  expect(
    await hooks.invoke(
      "operation",
      "workspace.create.before",
      {
        source: { kind: "directory", path: "/project" },
      },
      jagentdesk,
    ),
  ).toEqual({ source: { kind: "directory", path: "/project" }, title: "legacy:new:last" });
});

test.each(["agent.session_open", "agent.create.prepare", "nonsense"])(
  "addHook rejects unsupported name %s at registration",
  (name) => {
    const hooks = new PluginHookHandlers(() => {});
    // @ts-expect-error Runtime validation also protects untyped plugins.
    expect(() => hooks.addHook(name, async () => {})).toThrow(name);
  },
);

test.each([
  ["workspace.create", "workspace.create.before"],
  ["workspace.created", "workspace.create.after"],
  ["workspace.archived", "workspace.archive.after"],
  ["agent.create", "agent.create.before"],
  ["agent.created", "agent.create.after"],
  ["agent.session_open", "agent.open.before"],
  ["agent.closed", "agent.close.after"],
  ["agent.archived", "agent.archive.after"],
  ["agent.turn_started", "agent.turn.before"],
  ["agent.turn_ended", "agent.turn.after"],
  ["agent.permission_requested", "agent.permission.before"],
  ["agent.permission_resolved", "agent.permission.after"],
] as const)("legacy %s registers only %s across the process boundary", (oldName, newName) => {
  const hooks = new PluginHookHandlers(() => {});
  const handler = async () => {};
  const remove =
    oldName === "workspace.create" || oldName === "agent.create" || oldName === "agent.session_open"
      ? hooks.before(oldName, handler)
      : hooks.on(oldName, handler);
  hooks.addHook(newName, async () => {});
  expect(hooks.catalog()).toEqual([newName]);
  remove();
  expect(hooks.catalog()).toEqual([newName]);
  hooks.close();
  expect(hooks.catalog()).toEqual([]);
});

test("legacy notifications and addHook share payloads, registration order, and cleanup", async () => {
  const hooks = new PluginHookHandlers(() => {});
  const received: unknown[] = [];
  const remove = hooks.on("workspace.created", (event) => {
    received.push(["old", event]);
  });
  hooks.addHook("workspace.create.after", async (event) => {
    received.push(["new", event]);
  });
  const payload = {
    workspace: {
      id: "workspace",
      projectId: "project",
      cwd: "/project",
      name: null,
      archivedAt: null,
    },
  };
  await hooks.invoke("first", "workspace.create.after", payload, jagentdesk);
  remove();
  remove();
  await hooks.invoke("second", "workspace.create.after", payload, jagentdesk);
  expect(received).toEqual([
    ["old", payload],
    ["new", payload],
    ["new", payload],
  ]);
});

test("a waiting after hook propagates failures and stops later handlers", async () => {
  const hooks = new PluginHookHandlers(() => {});
  const received: string[] = [];
  hooks.addHook("worktree.create.after", async ({ worktree }) => {
    received.push(worktree.path);
    throw new Error("cannot initialize worktree");
  });
  hooks.addHook("worktree.create.after", async () => {
    received.push("unexpected later handler");
  });
  await expect(
    hooks.invoke(
      "worktree",
      "worktree.create.after",
      {
        worktree: { path: "/worktree", branch: "feature", sourceCheckout: "/source" },
      },
      jagentdesk,
    ),
  ).rejects.toThrow("cannot initialize worktree");
  expect(received).toEqual(["/worktree"]);
});

test("checkout-branch hooks reject a branch-off baseRef", async () => {
  const request = {
    kind: "checkout-branch" as const,
    repoRoot: "/repo",
    sourceCheckout: "/repo",
    branch: "feature",
    slug: "feature",
    path: "/work/feature",
  };
  await expect(
    validateBeforeResult("worktree.create.before", request, { ...request, baseRef: "main" }),
  ).rejects.toThrow(/baseRef/);
});

test("session-open instructions compose, survive old hooks, and are ignored for history", async () => {
  const hooks = new PluginHookHandlers(() => {});
  hooks.addHook("agent.open.before", async ({ request }) => ({
    ...request,
    appendSystemPrompt: [...(request.appendSystemPrompt ?? []), "first"],
  }));
  hooks.addHook("agent.open.before", async ({ request }) => {
    const { appendSystemPrompt: _ignored, ...oldRequest } = request;
    return oldRequest;
  });
  hooks.addHook("agent.open.before", async ({ request }) => ({
    ...request,
    appendSystemPrompt: [...(request.appendSystemPrompt ?? []), "second"],
  }));
  const input = {
    agentId: "agent",
    workspaceId: null,
    provider: "codex",
    cwd: "/project",
    reason: "resume",
    purpose: "interactive",
    env: {},
    title: null,
    labels: {},
    tools: [],
    mcpServers: {},
  };
  const interactive = await hooks.invoke("interactive", "agent.open.before", input, jagentdesk);
  expect(interactive).toMatchObject({ appendSystemPrompt: ["first", "second"] });
  const history = await hooks.invoke(
    "history",
    "agent.open.before",
    { ...input, purpose: "history" },
    jagentdesk,
  );
  expect(history).not.toHaveProperty("appendSystemPrompt");
});

const openInput = {
  agentId: "agent",
  workspaceId: null,
  provider: "codex",
  cwd: "/project",
  reason: "resume",
  purpose: "interactive",
  env: {},
  title: null,
  labels: {},
  metadata: {},
  tools: [],
  mcpServers: {},
};

type OpenHookResult = (request: Record<string, unknown>) => Record<string, unknown>;

/** Runs `results` as successive `agent.open.before` hooks of one plugin. */
async function invokeOpen(results: OpenHookResult[], input: Record<string, unknown> = openInput) {
  const hooks = new PluginHookHandlers(() => {});
  for (const result of results) {
    hooks.addHook("agent.open.before", async ({ request }) => result(request) as never);
  }
  return await hooks.invoke("open", "agent.open.before", input, jagentdesk);
}

const withWrap =
  (...wrap: string[]): OpenHookResult =>
  (request) => ({ ...request, wrap });

test("a session-open hook can select a launch wrap", async () => {
  expect(await invokeOpen([withWrap("/usr/local/bin/sandbox", "--profile", "a b")])).toMatchObject({
    wrap: ["/usr/local/bin/sandbox", "--profile", "a b"],
  });
});

test("a session-open hook result with an unknown key fails the open", async () => {
  await expect(invokeOpen([(request) => ({ ...request, notAHookField: true })])).rejects.toThrow(
    /notAHookField/,
  );
});

test.each<[string, OpenHookResult, Record<string, unknown>]>([
  [
    "omits it",
    ({ wrap: _wrap, ...request }) => ({ ...request, env: { LATER: "1" } }),
    { wrap: ["/usr/local/bin/sandbox"], env: { LATER: "1" } },
  ],
  ["repeats it", withWrap("/usr/local/bin/sandbox"), { wrap: ["/usr/local/bin/sandbox"] }],
])("an earlier wrap stays when a later session-open hook %s", async (_case, later, expected) => {
  expect(await invokeOpen([withWrap("/usr/local/bin/sandbox"), later])).toMatchObject(expected);
});

test.each<[string, OpenHookResult[], string]>([
  [
    "a later hook returns a different wrap",
    [withWrap("/usr/local/bin/sandbox"), withWrap("/usr/local/bin/other")],
    "cannot change a wrap",
  ],
  ["the executable is relative", [withWrap("sandbox")], "must be an absolute path"],
  ["the executable is empty", [withWrap("")], "must be an absolute path"],
])("a session-open wrap fails the open when %s", async (_case, results, message) => {
  await expect(invokeOpen(results)).rejects.toThrow(message);
});

test("a history open keeps the wrap while tools and MCP servers are stripped", async () => {
  const history = await invokeOpen(
    [
      (request) => ({
        ...request,
        wrap: ["/usr/local/bin/sandbox"],
        mcpServers: { extra: { type: "stdio", command: "/bin/server" } },
        appendSystemPrompt: ["history"],
      }),
    ],
    { ...openInput, purpose: "history" },
  );
  expect(history).toMatchObject({ wrap: ["/usr/local/bin/sandbox"], tools: [], mcpServers: {} });
  expect(history).not.toHaveProperty("appendSystemPrompt");
});

const terminalRequest = {
  workspaceId: "wks_a",
  cwd: "/work/a",
  source: "client" as const,
  name: "Shell",
  command: null,
  args: [],
  input: null,
  env: {},
};
const commandRequest = {
  workspaceId: null,
  cwd: "/work/a",
  purpose: "teardown" as const,
  command: "make clean && rm -rf build",
  env: {},
};

test("terminal and command hooks can change env and wrap", async () => {
  await expect(
    validateBeforeResult("terminal.create.before", terminalRequest, {
      ...terminalRequest,
      env: { WRAPPED: "1" },
      wrap: ["/usr/bin/sandbox", "--workspace", "wks_a"],
    }),
  ).resolves.toEqual({
    ...terminalRequest,
    env: { WRAPPED: "1" },
    wrap: ["/usr/bin/sandbox", "--workspace", "wks_a"],
  });
  await expect(
    validateBeforeResult("command.run.before", commandRequest, {
      ...commandRequest,
      wrap: ["/usr/bin/sandbox"],
    }),
  ).resolves.toMatchObject({ command: "make clean && rm -rf build", wrap: ["/usr/bin/sandbox"] });
});

test.each<[string, "terminal.create.before" | "command.run.before", object, object, string]>([
  [
    "a terminal's directory",
    "terminal.create.before",
    terminalRequest,
    { cwd: "/elsewhere" },
    "terminal.create.before hooks can only change env and wrap",
  ],
  [
    "a terminal's program",
    "terminal.create.before",
    terminalRequest,
    { command: "/usr/bin/sandbox" },
    "terminal.create.before hooks can only change env and wrap",
  ],
  [
    "a command's text",
    "command.run.before",
    commandRequest,
    { command: "sandbox make clean" },
    "command.run.before hooks can only change env and wrap",
  ],
  [
    "a command's purpose",
    "command.run.before",
    commandRequest,
    { purpose: "setup" },
    "command.run.before hooks can only change env and wrap",
  ],
  [
    "a relative wrap",
    "command.run.before",
    commandRequest,
    { wrap: ["sandbox"] },
    "wrap executable must be an absolute path",
  ],
])("a hook cannot change %s", async (_case, name, request, change, message) => {
  await expect(
    validateBeforeResult(name, request as never, { ...request, ...change }),
  ).rejects.toThrow(message);
});

test.each(["terminal.create.before", "command.run.before"] as const)(
  "%s keeps the first wrap and rejects a different one",
  async (name) => {
    const initial = name === "terminal.create.before" ? terminalRequest : commandRequest;
    const hooks = new PluginHookHandlers(() => {});
    hooks.addHook(
      name,
      async ({ request }) => ({ ...request, wrap: ["/usr/bin/sandbox"] }) as never,
    );
    hooks.addHook(name, async ({ request }) => {
      const { wrap: _omitted, ...rest } = request as typeof request & { wrap?: unknown };
      return { ...rest, env: { LATER: "1" } } as never;
    });
    await expect(hooks.invoke("first", name, initial, jagentdesk)).resolves.toMatchObject({
      wrap: ["/usr/bin/sandbox"],
      env: { LATER: "1" },
    });
    hooks.addHook(name, async ({ request }) => ({ ...request, wrap: ["/usr/bin/other"] }) as never);
    await expect(hooks.invoke("second", name, initial, jagentdesk)).rejects.toThrow(
      `${name} hooks cannot change a wrap an earlier hook selected`,
    );
  },
);

test("agent creation hooks keep the workspace, including from plugins that omit it", async () => {
  const request = {
    config: { provider: "claude", cwd: "/work/a" },
    metadata: { "issues.id": "ENG-1" },
    workspaceId: "wks_a",
  };
  // A result built before either field existed keeps both.
  await expect(
    validateBeforeResult("agent.create.before", request, { config: request.config }),
  ).resolves.toEqual(request);
  await expect(
    validateBeforeResult("agent.create.before", request, {
      config: request.config,
      metadata: { "issues.id": "ENG-2" },
    }),
  ).resolves.toEqual({ ...request, metadata: { "issues.id": "ENG-2" } });
  await expect(
    validateBeforeResult("agent.create.before", request, { ...request, workspaceId: "wks_b" }),
  ).rejects.toThrow("agent.create.before hooks cannot change the workspace");
});
