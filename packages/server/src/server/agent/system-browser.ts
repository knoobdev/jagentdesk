/**
 * The system browser is off limits while JAgentDesk browser tools are on (spec 04 §27b.3,
 * ADR-0057 §6): pages open in the app, never in the user's default browser. Providers use this
 * to refuse such shell commands and to turn off their own browser tooling.
 */

/** Codex bundled plugin skills that drive Chrome or the ChatGPT in-app browser. */
export const CODEX_PROVIDER_BROWSER_SKILLS = [
  "browser:control-in-app-browser",
  "chrome:control-chrome",
] as const;

/** Claude in Chrome's MCP server; a server-level rule covers all of its tools. */
export const CLAUDE_PROVIDER_BROWSER_TOOL_RULE = "mcp__claude-in-chrome";

export const SYSTEM_BROWSER_REFUSAL =
  "JAgentDesk opens web pages in its in-app browser. Use the browser_* tools (browser_new_tab, browser_navigate) instead of opening the system browser.";

/** Shell commands that hand a URL to the operating system's default browser. */
const SYSTEM_BROWSER_LAUNCHERS = [
  "open",
  "xdg-open",
  "gio open",
  "sensible-browser",
  "x-www-browser",
  "start",
  "cmd /c start",
  "explorer",
  "explorer.exe",
  "start-process",
  "rundll32 url.dll,fileprotocolhandler",
];

/**
 * True when a shell command line opens an http(s) URL in the system browser: `open`,
 * `xdg-open`, `start`, `Start-Process`, `python -m webbrowser`, or a browser binary given a URL.
 */
export function isSystemBrowserOpenCommand(command: string): boolean {
  if (!/https?:\/\//i.test(command) && !/\bwebbrowser\b/i.test(command)) return false;
  return command
    .split(/&&|\|\||;|\||\n/)
    .some((segment) => isSystemBrowserOpenSegment(segment.trim()));
}

function isSystemBrowserOpenSegment(segment: string): boolean {
  const words = segment
    .replace(/^(?:\s*(?:sudo|exec|command|nohup|env(?:\s+\w+=\S*)*)\s+)+/i, "")
    .trim();
  const lower = words.toLowerCase();
  if (/\bwebbrowser\b/.test(lower) && /\bpython[0-9.]*\b/.test(lower)) return true;
  if (!/https?:\/\//i.test(words)) return false;
  const program = lower.replace(/^\/(?:usr\/)?(?:local\/)?bin\//, "");
  if (SYSTEM_BROWSER_LAUNCHERS.some((launcher) => program.startsWith(`${launcher} `))) {
    return true;
  }
  return /^(?:google-chrome|chromium|chromium-browser|firefox|safari|microsoft-edge|msedge|brave-browser)\b/.test(
    program,
  );
}
