import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { Client, ClientChannel } from "ssh2";
import {
  buildCheckTargetScript,
  buildDeleteScript,
  buildExtractScript,
  buildLaunchJobScript,
  buildPollScript,
  buildStopScript,
  buildWriteCommandScript,
  buildWriteManifestScript,
  remotePathExpr,
  shellQuote,
} from "./remote-scripts.js";
import { execCollect, openExecChannel } from "./ssh-exec.js";

// sshd runs exec commands through the user's login shell (zsh, fish, …). The exec boundary must
// wrap every command in /bin/sh -c so the login shell never parses our snippets.

function recordingClient() {
  const commands: string[] = [];
  const client = {
    exec(command: string, callback: (error: Error | null, stream: ClientChannel) => void) {
      commands.push(command);
      const stream = new EventEmitter() as ClientChannel;
      Object.assign(stream, {
        stderr: new EventEmitter(),
        write: () => true,
        end: () => undefined,
        close: () => undefined,
      });
      queueMicrotask(() => {
        callback(null, stream);
        queueMicrotask(() => stream.emit("close"));
      });
    },
  } as unknown as Client;
  return { client, commands };
}

describe("exec channel /bin/sh wrapping", () => {
  it("sends every execCollect command as /bin/sh -c '<script>'", async () => {
    const { client, commands } = recordingClient();
    await execCollect(client, "uname -srm");
    await execCollect(client, `cat '/x/manifest.json' 2>/dev/null`, {
      stdin: Buffer.from("payload"),
    });
    expect(commands).toHaveLength(2);
    for (const command of commands) {
      expect(command.startsWith("/bin/sh -c '")).toBe(true);
    }
  });

  it("wraps the extract channel command too", async () => {
    const { client, commands } = recordingClient();
    const channel = await openExecChannel(client, "mkdir -p '/x/src' && tar -xzf - -C '/x/src'");
    channel.close();
    expect(commands).toHaveLength(1);
    expect(commands[0]?.startsWith("/bin/sh -c '")).toBe(true);
  });

  it("wraps every remote script builder through the exec boundary", async () => {
    const jobDir = remotePathExpr("/srv", "wsk_1", "jobs", "rjb_1");
    const scripts = [
      "mkdir -p '/srv'",
      buildCheckTargetScript("~/remote-exec"),
      buildWriteCommandScript(jobDir),
      buildLaunchJobScript({
        srcDirExpr: remotePathExpr("/srv", "wsk_1", "src"),
        jobDirExpr: jobDir,
      }),
      buildPollScript({ jobDirExpr: jobDir, offset: 0, cap: 4096 }),
      buildStopScript({ jobDirExpr: jobDir }),
      buildExtractScript(remotePathExpr("/srv", "wsk_1", "src")),
      buildDeleteScript(remotePathExpr("/srv", "wsk_1", "src")),
      buildWriteManifestScript(
        remotePathExpr("/srv", "wsk_1", "manifest.json"),
        remotePathExpr("/srv", "wsk_1"),
      ),
    ];
    const { client, commands } = recordingClient();
    for (const script of scripts) {
      await execCollect(client, script);
    }
    expect(commands).toHaveLength(scripts.length);
    for (const command of commands) {
      expect(command.startsWith("/bin/sh -c '")).toBe(true);
    }
  });

  it("keeps stdin piping and quoted payloads intact through a real /bin/sh", async () => {
    const { client, commands } = recordingClient();
    await execCollect(client, `printf %s ${shellQuote("it's a $HOME `x`")}\nprintf %s two`);
    // The captured command is exactly what would go over the wire; run it through the real shell.
    const printed = execFileSync("/bin/sh", ["-c", commands[0]!]).toString();
    expect(printed).toBe("it's a $HOME `x`two");
  });
});
