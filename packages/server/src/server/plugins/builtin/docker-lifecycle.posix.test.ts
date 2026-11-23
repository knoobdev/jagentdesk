import { mkdtemp, readFile, writeFile, chmod, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { DockerService } from "../../docker/docker-service.js";
import { DockerStreams } from "../../docker/docker-streams.js";
import { DaemonConfigStore } from "../../daemon-config-store.js";
import { MutableDaemonConfigSchema } from "@jagentdesk/protocol/messages";
import { BuiltinPluginState } from "./state.js";

it("stops a real docker events child within five seconds and permits a fresh subscription", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "jad-docker-lifecycle-"));
  const previousPath = process.env.PATH;
  const pidFile = path.join(home, "events.pid");
  const bin = path.join(home, "docker");
  // Local CLI adapter: every invocation is a real subprocess; only the Docker host is isolated.
  await writeFile(
    bin,
    `#!${process.execPath}\nconst fs = require('node:fs');\nif (process.argv[2] === 'events') { fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000); }\n`,
  );
  await chmod(bin, 0o755);
  process.env.PATH = `${home}${path.delimiter}${previousPath}`;
  const streams = new DockerStreams(new DockerService());
  const state = new BuiltinPluginState(
    new DaemonConfigStore(
      home,
      MutableDaemonConfigSchema.parse({
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
      }),
    ),
  );
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    await state.registerLifecycle("docker", { start: () => {}, stop: () => streams.disposeAll() });
    await streams.subscribeSnapshot("one", () => {});
    await expect
      .poll(async () => Number(await readFile(pidFile, "utf8").catch(() => "0")))
      .toBeGreaterThan(0);
    const before = Number(await readFile(pidFile, "utf8"));
    expect(alive(before)).toBe(true);
    const start = performance.now();
    await state.set("docker", false);
    await expect.poll(() => alive(before), { timeout: 5_000 }).toBe(false);
    expect(performance.now() - start).toBeLessThan(5_000);
    await state.set("docker", true);
    await streams.subscribeSnapshot("two", () => {});
    await expect.poll(async () => Number(await readFile(pidFile, "utf8"))).not.toBe(before);
    expect(alive(Number(await readFile(pidFile, "utf8")))).toBe(true);
  } finally {
    streams.disposeAll();
    process.env.PATH = previousPath;
    await rm(home, { recursive: true, force: true });
  }
});

it("does not spawn events when disable races with the initial Docker list", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  class DelayedDockerService extends DockerService {
    override async list() {
      await pending;
      return { available: true, containers: [], images: [], volumes: [] };
    }
  }
  const streams = new DockerStreams(new DelayedDockerService());
  const snapshots: boolean[] = [];
  const subscribing = streams.subscribeSnapshot("race", (snapshot) => {
    snapshots.push(snapshot.available);
  });
  streams.disposeAll();
  release();
  await subscribing;
  expect(snapshots).toEqual([]);
});
