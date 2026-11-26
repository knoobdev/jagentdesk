import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { DockerService } from "../../../packages/server/src/server/plugins/builtin/host-test-api.js";
import { DockerStreams } from "./streams.js";

let home = "";
let previousPath: string | undefined;
let eventsLog = "";

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "jad-docker-race-"));
  eventsLog = path.join(home, "events.log");
  previousPath = process.env.PATH;
  // Real subprocesses: `docker events` appends its pid and stays up; every other command answers
  // after 400 ms with no output, so the first list is still in flight when the unsubscribe lands.
  const bin = path.join(home, "docker");
  await writeFile(
    bin,
    `#!${process.execPath}\nconst fs = require('node:fs');\nif (process.argv[2] === 'events') { fs.appendFileSync(${JSON.stringify(eventsLog)}, process.pid + '\\n'); setInterval(() => {}, 1000); } else { setTimeout(() => process.exit(0), 400); }\n`,
  );
  await chmod(bin, 0o755);
  process.env.PATH = `${home}${path.delimiter}${previousPath}`;
});

afterEach(async () => {
  process.env.PATH = previousPath;
  const pids = (await readFile(eventsLog, "utf8").catch(() => "")).split("\n").filter(Boolean);
  for (const pid of pids) {
    try {
      process.kill(Number(pid));
    } catch {
      // already gone
    }
  }
  await rm(home, { recursive: true, force: true });
});

const startedWatchers = async () =>
  (await readFile(eventsLog, "utf8").catch(() => "")).split("\n").filter(Boolean).length;

it("does not start docker events when the unsubscribe lands during the first list", async () => {
  const streams = new DockerStreams(new DockerService());
  const subscribed = streams.subscribeSnapshot("sub-1", () => {}).catch(() => {});
  streams.unsubscribeSnapshot("sub-1");
  await subscribed;
  await new Promise((resolve) => setTimeout(resolve, 800));
  expect(await startedWatchers()).toBe(0);
  streams.disposeAll();
});

it("keeps one watcher when the same subscription is requested twice in a row", async () => {
  const streams = new DockerStreams(new DockerService());
  const first = streams.subscribeSnapshot("sub-1", () => {}).catch(() => {});
  const second = streams.subscribeSnapshot("sub-1", () => {}).catch(() => {});
  await Promise.all([first, second]);
  await new Promise((resolve) => setTimeout(resolve, 800));
  expect(await startedWatchers()).toBe(1);
  streams.disposeAll();
});
