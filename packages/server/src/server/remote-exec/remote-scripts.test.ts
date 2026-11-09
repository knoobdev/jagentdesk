import { describe, expect, it } from "vitest";
import {
  buildCheckTargetScript,
  buildDeleteScript,
  buildLaunchJobScript,
  buildPollScript,
  buildStopScript,
  remotePathExpr,
  REMOTE_LAUNCHER_SCRIPT,
  runUnderSh,
  shellQuote,
} from "./remote-scripts.js";

describe("shellQuote", () => {
  it("quotes spaces", () => {
    expect(shellQuote("a b/c")).toBe("'a b/c'");
  });

  it("escapes single quotes", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it("keeps double quotes and backslashes literal", () => {
    expect(shellQuote('say "hi" \\')).toBe(`'say "hi" \\'`);
  });

  it("keeps newlines and dollar signs literal", async () => {
    const quoted = shellQuote("line1\nline2 $HOME `x`");
    expect(quoted).toBe("'line1\nline2 $HOME `x`'");
    const { execFileSync } = await import("node:child_process");
    const printed = execFileSync("/bin/sh", ["-c", `printf %s ${quoted}`]).toString();
    expect(printed).toBe("line1\nline2 $HOME `x`");
  });

  it("quotes the empty string", () => {
    expect(shellQuote("")).toBe("''");
  });
});

describe("runUnderSh", () => {
  it("wraps the script in a single-quoted /bin/sh -c", () => {
    expect(runUnderSh("uname -srm")).toBe("/bin/sh -c 'uname -srm'");
  });

  it("escapes embedded single quotes", () => {
    expect(runUnderSh("echo 'it's'")).toBe("/bin/sh -c 'echo '\\''it'\\''s'\\'''");
  });

  it("keeps multi-line scripts with quotes intact through a real /bin/sh", async () => {
    const { execFileSync } = await import("node:child_process");
    const script = [
      `printf %s ${shellQuote("it's a $HOME `x`")}`,
      `printf %s ${shellQuote("second 'line'")}`,
    ].join("\n");
    const printed = execFileSync("/bin/sh", ["-c", runUnderSh(script)]).toString();
    expect(printed).toBe("it's a $HOME `x`second 'line'");
  });
});

describe("remotePathExpr", () => {
  it("resolves ~/ through $HOME without expanding user parts", () => {
    expect(remotePathExpr("~/work", "wsk_1", "src")).toBe('"$HOME/work/wsk_1/src"');
  });

  it("escapes dollar signs in the configured part", () => {
    expect(remotePathExpr("~/a$b", "src")).toBe('"$HOME/a\\$b/src"');
  });

  it("single-quotes absolute paths", () => {
    expect(remotePathExpr("/srv/work", "manifest.json")).toBe("'/srv/work/manifest.json'");
  });

  it("maps bare ~ to $HOME", () => {
    expect(remotePathExpr("~", "jobs")).toBe('"$HOME/jobs"');
  });
});

describe("script builders", () => {
  it("keeps the launcher free of single quotes so it can be embedded", () => {
    expect(REMOTE_LAUNCHER_SCRIPT).not.toContain("'");
    expect(REMOTE_LAUNCHER_SCRIPT).toContain('-lc "$(cat "$1")"');
    expect(REMOTE_LAUNCHER_SCRIPT).toContain('>"$3.tmp" && mv "$3.tmp" "$3"');
  });

  it("embeds the launcher and passes command/log/exit_code as positional args", () => {
    const script = buildLaunchJobScript({
      srcDirExpr: "'/srv/wsk_1/src'",
      jobDirExpr: "'/srv/wsk_1/jobs/rjb_1'",
    });
    expect(script).toContain("cd '/srv/wsk_1/src' || exit 3");
    expect(script).toContain("setsid /bin/sh -c '");
    expect(script).toContain("echo $! > '/srv/wsk_1/jobs/rjb_1'/pid");
  });

  it("passes the three launcher arguments individually", () => {
    const script = buildLaunchJobScript({
      srcDirExpr: "'/srv/src'",
      jobDirExpr: "'/srv/jobs/rjb_1'",
    });
    expect(script).toContain(
      "launcher '/srv/jobs/rjb_1'/command '/srv/jobs/rjb_1'/output.log '/srv/jobs/rjb_1'/exit_code",
    );
    expect(script).toContain("echo $! > '/srv/jobs/rjb_1'/pid");
  });

  it("reads new poll bytes from the 1-based tail offset with a cap", () => {
    const script = buildPollScript({ jobDirExpr: "'/j/rjb_1'", offset: 128, cap: 1024 });
    expect(script).toContain("tail -c +129 '/j/rjb_1'/output.log 2>/dev/null | head -c 1024");
    expect(script).toContain(">&2");
  });

  it("stops via the process group with a 10 s grace before SIGKILL", () => {
    const script = buildStopScript({ jobDirExpr: "'/j/rjb_1'" });
    expect(script).toContain('kill -TERM -"$pid"');
    expect(script).toMatch(/-lt 20/);
    expect(script).toContain('kill -KILL -"$pid"');
    expect(script).toContain("printf 'STOPPED\\n'");
  });

  it("deletes only inside src via NUL-separated stdin without recursing", () => {
    expect(buildDeleteScript("'/srv/src'")).toBe("cd '/srv/src' && xargs -0 rm -f --");
  });

  it("probes the workRoot for the check-target report", () => {
    const script = buildCheckTargetScript("~/remote-exec");
    expect(script).toContain("uname -srm");
    expect(script).toContain("for t in tar setsid kill mkdir rm cat");
    expect(script).toContain('df -kP "$HOME/remote-exec"');
    expect(script).toContain("WRITABLE yes");
  });
});
