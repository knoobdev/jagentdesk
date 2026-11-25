# Ad-hoc daemon testing

Spin up an isolated in-process daemon without touching the main daemon on port 6767.

This is for test code only. Executable daemon processes must start through
`scripts/supervisor-entrypoint.ts` or `dist/scripts/supervisor-entrypoint.js`;
do not use `createJAgentDeskDaemon` as a product launch path.

## Quick start

`createDaemonTestContext` (`packages/server/src/server/test-utils/daemon-test-context.ts`) starts a daemon on a free port in temp dirs, connects a `DaemonClient`, and subscribes to agents:

```typescript
import { createDaemonTestContext } from "./test-utils/daemon-test-context.js";

const ctx = await createDaemonTestContext();
try {
  const agent = await ctx.client.createAgent({ provider: "codex", cwd: "/tmp" });
  // ... test ...
} finally {
  await ctx.cleanup(); // closes the client, stops the daemon, removes temp dirs
}
```

It forwards its options to `createTestJAgentDeskDaemon` (`test-utils/jagentdesk-daemon.ts`). By default that helper:

- uses fake agent clients for `claude`, `codex`, and `opencode` (`createTestAgentClients`); pass `agentClients` to use real ones;
- enables MCP and disables the relay (pass `relay` to enable it);
- accepts `providerOverrides`, `plugins`, `auth`, `speech`, `webUi`, `serviceProxy`, and the other options listed in `TestJAgentDeskDaemonOptions`.

Use the helper directly when you need a custom client:

```typescript
import { createTestJAgentDeskDaemon } from "./test-utils/jagentdesk-daemon.js";
import { DaemonClient } from "./test-utils/daemon-client.js";

const daemon = await createTestJAgentDeskDaemon();
const client = new DaemonClient({
  url: `ws://127.0.0.1:${daemon.port}/ws`,
  appVersion: "0.10.0", // see gotcha 1
});
await client.connect();
await client.fetchAgents({ subscribe: { subscriptionId: "test" } });

// ... test ...

await client.close();
await daemon.close(); // stops the daemon and cleans up temp dirs
```

Call `createJAgentDeskDaemon` from `bootstrap.ts` yourself only when you need a `JAgentDeskDaemonConfig` field the helper does not expose. Copy the config shape from `prepareTestDaemonConfig` in `test-utils/jagentdesk-daemon.ts`.

Run a one-off script with:

```bash
npx tsx packages/server/src/server/your-script.ts
```

## Common client methods

```typescript
// Provider discovery
const snapshot = await client.getProvidersSnapshot({ cwd: "/tmp" });
const models = await client.listProviderModels("claude");
const modes = await client.listProviderModes("claude");

// Agent lifecycle
const agent = await client.createAgent({ provider: "claude", cwd: "/tmp" });
await client.sendMessage(agent.id, "Hello");
const updated = await client.waitForAgentUpsert(agent.id, (s) => s.status === "idle");
```

## Gotchas

### 1. appVersion switches compatibility paths

The session reads the client's `appVersion` to decide which compatibility paths to take (`packages/server/src/server/session.ts`). Without one, or with an old one, the daemon hides providers other than `claude`, `codex`, and `opencode` (below `0.1.45`) and uses legacy workspace restore (below `0.1.105`). `DaemonClient` sends no version by default, so ACP and other custom providers are missing from snapshots.

Pass the current app version when the test depends on current behavior:

```typescript
const client = new DaemonClient({
  url: `ws://127.0.0.1:${port}/ws`,
  appVersion: "0.10.0",
});
```

### 2. Provider snapshots are async

After the daemon starts, providers are probed in the background. The first `getProvidersSnapshot()` call returns `status: "loading"` for most providers. Poll until the provider you care about is no longer loading:

```typescript
let snapshot = await client.getProvidersSnapshot({ cwd: "/tmp" });
for (let i = 0; i < 20; i++) {
  const entry = snapshot.entries.find((e) => e.provider === "gemini");
  if (entry && entry.status !== "loading") break;
  await new Promise((r) => setTimeout(r, 2_000));
  snapshot = await client.getProvidersSnapshot({ cwd: "/tmp" });
}
```

### 3. Call fetchAgents after connecting

Call `client.fetchAgents({ subscribe: ... })` right after `connect()`, as `createDaemonTestContext` does. Requests sent before that handshake, such as `get_providers_snapshot_request`, can hang.

### 4. Use port 0

The helpers listen on `127.0.0.1:0` so the OS picks a free port. Never hardcode a port; it collides with the main daemon or other test runs.

### 5. Scripts live inside packages/server

The test utilities use relative imports through the server TypeScript project. Put your script under `packages/server/src/`. Scripts outside the repo fail with module resolution errors.

### 6. Clean up on failure

Wrap test logic in `try`/`finally` so the daemon stops and temp dirs are removed even when an assertion fails.

### 7. ACP providers spawn real processes

ACP providers (`extends: "acp"`, see [custom-providers.md](custom-providers.md)) make the daemon spawn the agent binary to probe models and modes. The binary must be installed and on `PATH`, and probing takes several seconds.
