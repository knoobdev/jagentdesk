import { describe, expect, test } from "vitest";
import { parseBackgroundCommand, parseReadCommand } from "./command-parse.js";

const context = { cwd: "/repo", home: "/home/me" };

function redirects(command: string, cwd: string | null = "/repo"): string[] {
  return parseBackgroundCommand(command, { cwd, home: "/home/me" }).redirects;
}

function script(command: string): string | null {
  return parseBackgroundCommand(command, context).script;
}

// ADR-0064 §1: the files a background command writes its output to.
describe("redirect targets", () => {
  test.each([
    ["npm test > /tmp/t.log", ["/tmp/t.log"]],
    ["npm test >> /tmp/t.log", ["/tmp/t.log"]],
    ["npm test 1> /tmp/t.log", ["/tmp/t.log"]],
    ["npm test 2> /tmp/err.log", ["/tmp/err.log"]],
    ["npm test &> /tmp/t.log", ["/tmp/t.log"]],
    ["npm test &>> /tmp/t.log", ["/tmp/t.log"]],
    ["npm test >/tmp/t.log 2>&1", ["/tmp/t.log"]],
    ["npm test 2>&1 > /tmp/t.log", ["/tmp/t.log"]],
    ["npm test >& /tmp/t.log", ["/tmp/t.log"]],
    ["npm test >| /tmp/t.log", ["/tmp/t.log"]],
    ["npm test > /tmp/out.log 2> /tmp/err.log", ["/tmp/out.log", "/tmp/err.log"]],
    ["npm test 2>&1 | tee /tmp/t.log", ["/tmp/t.log"]],
    ["npm test | tee -a /tmp/t.log", ["/tmp/t.log"]],
    ["npm test |& tee --append /tmp/a.log /tmp/b.log", ["/tmp/a.log", "/tmp/b.log"]],
    ["npm test > '/tmp/my log.txt'", ["/tmp/my log.txt"]],
    ['npm test > "/tmp/quoted.log"', ["/tmp/quoted.log"]],
    ["npm test > /tmp/a\\ b.log", ["/tmp/a b.log"]],
    ["nohup ./serve.sh > /tmp/serve.log 2>&1 &", ["/tmp/serve.log"]],
    ["sleep 1; echo done >> /tmp/x.log && cat /tmp/x.log", ["/tmp/x.log"]],
  ])("%s", (command, expected) => {
    expect(redirects(command)).toEqual(expected);
  });

  test("relative targets start in the work's folder", () => {
    expect(redirects("npm test > logs/t.log")).toEqual(["/repo/logs/t.log"]);
    expect(redirects("npm test > ../t.log")).toEqual(["/t.log"]);
    expect(redirects("npm test > logs/t.log", null)).toEqual([]);
  });

  test("follows a literal cd and drops relative targets after an unknown one", () => {
    expect(redirects("cd /work && make > build.log")).toEqual(["/work/build.log"]);
    expect(redirects("cd sub && make > build.log")).toEqual(["/repo/sub/build.log"]);
    expect(redirects("cd $DIR && make > build.log")).toEqual([]);
    expect(redirects("cd - && make > /tmp/abs.log")).toEqual(["/tmp/abs.log"]);
  });

  test("expands ~ to the home folder", () => {
    expect(redirects("cmd > ~/.ssh/x")).toEqual(["/home/me/.ssh/x"]);
  });

  test("reads the command inside sh -c and bash -lc", () => {
    expect(redirects('sh -c "npm test > /tmp/t.log 2>&1"')).toEqual(["/tmp/t.log"]);
    expect(redirects("/bin/zsh -lc 'npm test | tee -a /tmp/t.log'")).toEqual(["/tmp/t.log"]);
    expect(redirects("bash -l -c 'make > /tmp/m.log'")).toEqual(["/tmp/m.log"]);
  });

  test("ignores inputs and descriptor duplication", () => {
    expect(redirects("sort < /tmp/in.txt 2>&1 3>&2")).toEqual([]);
    expect(redirects("cmd 3> /tmp/fd3.log")).toEqual([]);
  });

  test("skips one word it cannot read literally and keeps the others", () => {
    expect(redirects("cmd > $HOME/x.log 2> /tmp/err.log")).toEqual(["/tmp/err.log"]);
    expect(redirects('cmd > "/tmp/$NAME.log"')).toEqual([]);
    expect(redirects("cmd > /tmp/*.log")).toEqual([]);
    expect(redirects("cmd > /tmp/{a,b}.log")).toEqual([]);
    expect(redirects("cmd > ~other/x.log")).toEqual([]);
  });

  test.each([
    "cmd > /tmp/t-$(date +%s).log",
    "cmd > /tmp/`date`.log",
    "(cd /x && make) > /tmp/m.log",
    "cat <<EOF > /tmp/x.log\nhello\nEOF",
    "diff <(ls a) <(ls b) > /tmp/d.log",
    "cmd > /tmp/'unterminated.log",
    'sh -c "$CMD > /tmp/x.log"',
  ])("gives nothing for a command it cannot be sure of: %s", (command) => {
    expect(parseBackgroundCommand(command, context)).toEqual({ redirects: [], script: null });
  });
});

// ADR-0064 §2: the script the command runs.
describe("script", () => {
  test.each([
    ["zsh /tmp/wait-v2fix3.sh", "/tmp/wait-v2fix3.sh"],
    ["bash -x scripts/run.sh --fast", "/repo/scripts/run.sh"],
    ["sh ./wait.sh", "/repo/wait.sh"],
    ["fish /tmp/w.fish", "/tmp/w.fish"],
    ["node --require ./hook.js tools/watch.mjs", "/repo/tools/watch.mjs"],
    ["python3 -u /tmp/poll.py", "/tmp/poll.py"],
    ["python poll.py", "/repo/poll.py"],
    ["ruby script.rb", "/repo/script.rb"],
    ["bun run scripts/dev.ts", "/repo/scripts/dev.ts"],
    ["bun scripts/dev.ts", "/repo/scripts/dev.ts"],
    ["deno run --allow-net /tmp/serve.ts", "/tmp/serve.ts"],
    ["./x.sh arg", "/repo/x.sh"],
    ["/tmp/x.sh", "/tmp/x.sh"],
    ["FOO=1 nice -n 5 timeout 60 bash /tmp/w.sh", "/tmp/w.sh"],
    ["env -u X BAR=2 /usr/bin/env node /tmp/a.js", "/tmp/a.js"],
    ["nohup ./serve.sh > /tmp/serve.log 2>&1 &", "/repo/serve.sh"],
    ["sh -c 'zsh /tmp/inner.sh > /tmp/o.log'", "/tmp/inner.sh"],
  ])("%s", (command, expected) => {
    expect(script(command)).toBe(expected);
  });

  test.each([
    "npm test",
    "python -m http.server",
    "node -e 'console.log(1)'",
    "bash -c 'echo hi'",
    "deno fmt",
    "zsh",
    "bash $SCRIPT",
  ])("none for %s", (command) => {
    expect(script(command)).toBeNull();
  });
});

// ADR-0064 §3: which files an agent's own shell call reads.
describe("read commands", () => {
  test.each([
    ["tail -n 50 /tmp/t.log", "/tmp/t.log"],
    ["cat /tmp/t.log", "/tmp/t.log"],
    ["head -c 100 logs/t.log", "/repo/logs/t.log"],
    ["less /tmp/t.log", "/tmp/t.log"],
    ["tail -f /tmp/t.log | grep FAIL", "/tmp/t.log"],
    ["bash -lc 'tail -20 /tmp/t.log'", "/tmp/t.log"],
    ["sleep 5 && cat /tmp/t.log", "/tmp/t.log"],
  ])("%s", (command, path) => {
    expect(parseReadCommand(command, context)).toContain(path);
  });

  test("not a read", () => {
    expect(parseReadCommand("grep FAIL /tmp/t.log", context)).toEqual([]);
    expect(parseReadCommand("tail $(ls /tmp/*.log)", context)).toEqual([]);
  });
});
