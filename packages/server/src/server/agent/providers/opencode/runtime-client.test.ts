import { expect, test } from "vitest";
import { openCodeMajorVersion } from "./runtime-client.js";

test.each([
  ["1.14.46", 1],
  ["unexpected wrapper output", 1],
  ["", 1],
  ["opencode v2.0.10\n", 2],
  ["v2.0.10-beta.1", 2],
])("identifies the OpenCode runtime version %s", (output, major) => {
  expect(openCodeMajorVersion(String(output))).toBe(major);
});

test.each(["3.0.0", "2.0.9", "2.0.7", "2.0.4", "2.0.3", "v2.0.1"])(
  "rejects unsupported OpenCode version output %s",
  (output) => {
    expect(() => openCodeMajorVersion(output)).toThrow();
  },
);

test("retries a rejected version probe after the configured binary changes", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { OpenCodeRuntimeClient } = await import("./runtime-client.js");
  const { createTestLogger } = await import("../../../../test-utils/test-logger.js");
  const root = await mkdtemp(join(tmpdir(), "opencode-version-probe-"));
  const script = join(root, "version.cjs");
  const client = new OpenCodeRuntimeClient(createTestLogger(), {
    command: { mode: "replace", argv: [process.execPath, script] },
    env: { XDG_STATE_HOME: root },
  });
  try {
    await writeFile(script, 'console.log("opencode v2.0.3")');
    await expect(client.fetchCatalog({ scope: "global", force: true })).rejects.toThrow(
      "Update OpenCode to 2.0.10 or newer, then refresh the provider in JAgentDesk",
    );
    await writeFile(script, 'console.log("opencode v3.0.0")');
    await expect(client.fetchCatalog({ scope: "global", force: true })).rejects.toThrow(
      "Unsupported OpenCode major version 3",
    );
  } finally {
    await client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  ["console.log('wrapper output')", "unrecognized output"],
  ["process.exit(1)", "failed command"],
])("retries a %s version probe after updating to v2 (%s)", async (initialSource) => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { OpenCodeRuntimeClient } = await import("./runtime-client.js");
  const { createTestLogger } = await import("../../../../test-utils/test-logger.js");
  const root = await mkdtemp(join(tmpdir(), "opencode-version-retry-"));
  const script = join(root, "version.cjs");
  const client = new OpenCodeRuntimeClient(createTestLogger(), {
    command: { mode: "replace", argv: [process.execPath, script] },
    env: { XDG_STATE_HOME: root },
  });
  try {
    await writeFile(script, initialSource);
    expect((await client.listFeatures({ provider: "opencode", cwd: root }))[0]?.label).toBe(
      "Auto Accept",
    );
    await writeFile(script, 'console.log("opencode v2.0.10")');
    expect((await client.listFeatures({ provider: "opencode", cwd: root }))[0]?.label).toBe(
      "Auto-accept",
    );
  } finally {
    await client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  "process.exit(1)",
  'console.log("custom wrapper output")',
  "setTimeout(() => {}, 30000)",
])(
  "preserves legacy operations when the version probe is inconclusive: %s",
  async (source) => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { OpenCodeRuntimeClient } = await import("./runtime-client.js");
    const { OpenCodeAgentClient } = await import("../opencode-agent.js");
    const { createTestLogger } = await import("../../../../test-utils/test-logger.js");
    const { OpenCodeServerManager } = await import("./server-manager.js");
    const root = await mkdtemp(join(tmpdir(), "opencode-legacy-probe-"));
    const script = join(root, "version.cjs");
    await writeFile(script, source);
    const logger = createTestLogger();
    let legacyShutdown = false;
    class TrackedServerManager extends OpenCodeServerManager {
      override async shutdown() {
        legacyShutdown = true;
        await super.shutdown();
      }
    }
    const client = new OpenCodeRuntimeClient(
      logger,
      {
        command: { mode: "replace", argv: [process.execPath, script] },
        env: { XDG_STATE_HOME: root },
      },
      { serverManager: new TrackedServerManager({ logger }) },
    );
    const legacy = new OpenCodeAgentClient(logger);
    const config = { provider: "opencode", cwd: root };
    try {
      expect(await client.listFeatures(config)).toEqual(await legacy.listFeatures(config));
    } finally {
      await client.shutdown();
      await legacy.shutdown();
      await rm(root, { recursive: true, force: true });
    }
    expect(legacyShutdown).toBe(true);
  },
  10000,
);

test("selects v2 without probing the binary when an external server is configured", async () => {
  const { OpenCodeRuntimeClient } = await import("./runtime-client.js");
  const { createTestLogger } = await import("../../../../test-utils/test-logger.js");
  const client = new OpenCodeRuntimeClient(createTestLogger(), {
    command: { mode: "replace", argv: [process.execPath, "-e", "process.exit(1)"] },
    env: { JAGENTDESK_OPENCODE_SERVER_URL: "http://127.0.0.1:4096" },
  });
  try {
    const features = await client.listFeatures({ provider: "opencode", cwd: "/tmp/project" });
    expect(features.map((feature) => feature.label)).toEqual(["Auto-accept"]);
  } finally {
    await client.shutdown();
  }
});

test("keeps native JAgentDesk tools available when an external server is configured", async () => {
  const { OpenCodeRuntimeClient } = await import("./runtime-client.js");
  const { createTestLogger } = await import("../../../../test-utils/test-logger.js");
  const { OpenCodeBridge } = await import("./bridge.js");
  const bridge = new OpenCodeBridge({ jagentdeskHome: "/tmp", logger: createTestLogger() });
  const external = new OpenCodeRuntimeClient(
    createTestLogger(),
    { env: { JAGENTDESK_OPENCODE_SERVER_URL: "http://127.0.0.1:4096" } },
    { bridge },
  );
  const local = new OpenCodeRuntimeClient(createTestLogger(), undefined, { bridge });
  try {
    expect(external.capabilities.supportsNativeJAgentDeskTools).toBe(true);
    expect(local.capabilities.supportsNativeJAgentDeskTools).toBe(true);
  } finally {
    await external.shutdown();
    await local.shutdown();
  }
});
