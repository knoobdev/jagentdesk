import { describe, expect, test } from "vitest";
import { isSystemBrowserOpenCommand } from "./system-browser.js";
import { refuseSystemBrowserBashHook } from "./providers/claude/agent.js";
import { codexProviderBrowserOverrides } from "./providers/codex-app-server-agent.js";

describe("isSystemBrowserOpenCommand", () => {
  test.each([
    "open https://example.org",
    "/usr/bin/open 'https://example.org/a?b=1'",
    'open -a "Google Chrome" https://example.org',
    "cd /tmp && open http://localhost:3000",
    "xdg-open https://example.org",
    "sudo xdg-open https://example.org",
    "gio open https://example.org",
    "start https://example.org",
    "cmd /c start https://example.org",
    'Start-Process "https://example.org"',
    "explorer.exe https://example.org",
    "python3 -m webbrowser https://example.org",
    "python -c 'import webbrowser; webbrowser.open(\"https://example.org\")'",
    "google-chrome https://example.org",
    "firefox --new-tab https://example.org",
  ])("refuses %s", (command) => {
    expect(isSystemBrowserOpenCommand(command)).toBe(true);
  });

  test.each([
    "open .",
    "open README.md",
    "curl -s https://example.org",
    "git clone https://github.com/example/repo",
    'echo "open https://example.org"',
    "npm view react homepage",
    "opencode run 'look at https://example.org'",
    "startup.sh https://example.org",
  ])("allows %s", (command) => {
    expect(isSystemBrowserOpenCommand(command)).toBe(false);
  });
});

describe("Claude system browser hook", () => {
  const signal = new AbortController().signal;
  const bash = (command: string) =>
    ({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command },
      tool_use_id: "tool-1",
      session_id: "session",
      transcript_path: "/tmp/transcript",
      cwd: "/tmp",
    }) as Parameters<typeof refuseSystemBrowserBashHook>[0];

  test("denies a Bash command that opens the system browser and names the browser tools", async () => {
    const result = await refuseSystemBrowserBashHook(bash("open https://example.org"), "tool-1", {
      signal,
    });
    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining("browser_new_tab"),
      },
    });
  });

  test("leaves other Bash commands alone", async () => {
    expect(await refuseSystemBrowserBashHook(bash("ls -la"), "tool-1", { signal })).toEqual({});
  });
});

describe("Codex provider browser overrides", () => {
  test("turn off the bundled Browser and Chrome skills by name", () => {
    expect(codexProviderBrowserOverrides()).toEqual([
      "-c",
      'skills.config=[{name="browser:control-in-app-browser",enabled=false},{name="chrome:control-chrome",enabled=false}]',
    ]);
  });
});
