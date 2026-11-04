import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { GoIos } from "./go-ios.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A stand-in `ios` that records the directory it ran in and its arguments.
function fakeIos(): { bin: string; record: string; root: string } {
  const root = mkdtempSync(path.join(tmpdir(), "jad-goios-"));
  dirs.push(root);
  const record = path.join(root, "record.txt");
  const bin = path.join(root, "ios");
  writeFileSync(bin, `#!/bin/sh\necho "$PWD|$*" >> "${record}"\n`);
  chmodSync(bin, 0o755);
  return { bin, record, root };
}

describe("GoIos working directory", () => {
  it("runs commands and the tunnel in its writable work dir, with pair records there", async () => {
    const { bin, record, root } = fakeIos();
    const workDir = path.join(root, "devices", "go-ios");
    const goIos = new GoIos(bin, pino({ level: "silent" }), workDir);
    await goIos.run(["list"]);
    const tunnel = goIos.tunnel();
    await new Promise((resolve) => tunnel.on("exit", resolve));
    const lines = readFileSync(record, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    // macOS reports /var/… as /private/var/… in $PWD.
    const realWorkDir = realpathSync(workDir);
    for (const line of lines) expect(line.startsWith(`${realWorkDir}|`)).toBe(true);
    expect(lines[1]).toContain(`tunnel start --userspace --pair-record-path=${workDir}`);
  });

  it("keeps the old behaviour without a work dir", async () => {
    const { bin, record } = fakeIos();
    const tunnel = new GoIos(bin, pino({ level: "silent" })).tunnel();
    await new Promise((resolve) => tunnel.on("exit", resolve));
    expect(readFileSync(record, "utf8")).not.toContain("--pair-record-path");
  });
});
