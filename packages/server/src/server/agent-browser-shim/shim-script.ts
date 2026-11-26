/**
 * The agent browser shim (spec 04 §27b item 3b): one file that is both a POSIX shell script and a
 * CommonJS program. Installed as `open`, `xdg-open` and `jagentdesk-browser.js` in a directory the
 * daemon puts first on every agent's PATH, with BROWSER pointing at the `.js` copy.
 *
 * - Run by a shell (`open x`, Python's webbrowser, `$BROWSER url`): line 2 re-executes the file
 *   with the daemon's own Node.
 * - Run by Node (Vite, Create React App and webpack-dev-server run a `.js` BROWSER with
 *   `node <script> ...argv <url>`): line 2 is a string statement and a comment.
 *
 * Web targets (http(s) URLs, local .html/.htm/.svg/.pdf files) go to the daemon, which opens them
 * as an in-app tab of the agent's workspace. Anything else runs the real system command with the
 * same arguments. The shim never opens the system browser itself.
 */

export const NO_BROWSER_HOST_MESSAGE =
  "No JAgentDesk browser is connected; tell the user the path instead";
export const OPENED_IN_APP_PREFIX = "Opened in the JAgentDesk browser:";
/** Present in every shim directory; a shim never passes through to another shim. */
export const SHIM_MARKER_FILE = ".jagentdesk-agent-shim";
export const SHIM_ENDPOINT_FILE = ".endpoint.json";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The shim source. `nodePath` is the daemon's Node (or Electron binary run as Node). */
export function renderAgentBrowserShim(input: { nodePath: string; electron: boolean }): string {
  const electronEnv = input.electron ? "ELECTRON_RUN_AS_NODE=1 JAGENTDESK_SHIM_ELECTRON=1 " : "";
  return `#!/bin/sh
":" //; ${electronEnv}exec ${shellQuote(input.nodePath)} "$0" "$@"
// JAgentDesk agent browser shim. Written by the JAgentDesk daemon at startup; edits are lost.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { fileURLToPath } = require("node:url");

const SHIM_DIR = __dirname;
const WEB_FILE = /\\.(?:html?|svg|pdf)$/i;
const NO_BROWSER = ${JSON.stringify(NO_BROWSER_HOST_MESSAGE)};
const OPENED = ${JSON.stringify(OPENED_IN_APP_PREFIX)};
const MARKER = ${JSON.stringify(SHIM_MARKER_FILE)};
// open(1) flags that only change how a URL is shown; dropped when the URL opens in the app.
const OPEN_VIEW_FLAGS = new Set(["-g", "-n", "-F", "-W", "-j", "--background", "--new", "--fresh", "--wait-apps", "--hide"]);

function modeOf(argv1) {
  const name = path.basename(argv1 || "").replace(/\\.(?:js|cjs|cmd)$/i, "").toLowerCase();
  if (name === "open" || name === "xdg-open" || name === "explorer") return name;
  return "browser";
}

/** A web target, or null when the argument is not one. */
function webTarget(arg, cwd) {
  if (/^https?:\\/\\//i.test(arg)) return { url: arg };
  let filePath = null;
  if (/^file:\\/\\//i.test(arg)) {
    try {
      filePath = fileURLToPath(arg);
    } catch {
      return null;
    }
  } else if (WEB_FILE.test(arg) && !/^[a-z][a-z0-9+.-]*:/i.test(arg)) {
    filePath = path.resolve(cwd, arg);
  }
  if (!filePath || !WEB_FILE.test(filePath)) return null;
  try {
    return fs.statSync(filePath).isFile() ? { path: filePath } : null;
  } catch {
    return null;
  }
}

function isShimDir(dir) {
  try {
    return fs.existsSync(path.join(dir, MARKER));
  } catch {
    return false;
  }
}

function findRealCommand(name) {
  const entries = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const extensions =
    process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of entries) {
    if (isShimDir(dir)) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return null;
}

function passThrough(name, args) {
  const real = findRealCommand(name);
  if (!real) {
    process.stderr.write(name + ": command not found\\n");
    return 127;
  }
  const env = { ...process.env };
  if (env.JAGENTDESK_SHIM_ELECTRON) {
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.JAGENTDESK_SHIM_ELECTRON;
  }
  const result = spawnSync(real, args, { stdio: "inherit", env });
  if (result.error) {
    process.stderr.write(name + ": " + result.error.message + "\\n");
    return 1;
  }
  return result.status === null ? 1 : result.status;
}

function readEndpoint() {
  try {
    return JSON.parse(fs.readFileSync(path.join(SHIM_DIR, ${JSON.stringify(SHIM_ENDPOINT_FILE)}), "utf8"));
  } catch {
    return null;
  }
}

async function openInApp(target) {
  const label = target.url || target.path;
  const agentId = process.env.JAGENTDESK_AGENT_ID;
  const endpoint = readEndpoint();
  if (!agentId || !endpoint || !endpoint.url) {
    process.stderr.write("Could not reach JAgentDesk to open " + label + ". " + NO_BROWSER + ".\\n");
    return 1;
  }
  let response;
  try {
    response = await fetch(endpoint.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + endpoint.token },
      body: JSON.stringify({ agentId, target }),
      signal: AbortSignal.timeout(120000),
    });
  } catch {
    process.stderr.write("Could not reach JAgentDesk to open " + label + ". " + NO_BROWSER + ".\\n");
    return 1;
  }
  let body = null;
  try {
    body = await response.json();
  } catch {}
  if (response.ok && body && body.ok) {
    process.stdout.write(OPENED + " " + body.url + (target.path ? " (" + target.path + ")" : "") + "\\n");
    return 0;
  }
  const message = body && typeof body.message === "string" ? body.message : NO_BROWSER;
  process.stderr.write(message + "\\n");
  return 1;
}

async function openAll(targets) {
  let status = 0;
  for (const target of targets) {
    const code = await openInApp(target);
    if (code !== 0) status = code;
  }
  return status;
}

async function runOpen(args) {
  const cwd = process.cwd();
  const operands = [];
  const passFlags = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-u" && index + 1 < args.length) {
      operands.push(args[++index]);
    } else if (OPEN_VIEW_FLAGS.has(arg)) {
      passFlags.push(arg);
    } else if (arg.startsWith("-")) {
      // -a App, -b bundle, -e, -t, -R, --args …: the caller chose an application.
      return passThrough("open", args);
    } else {
      operands.push(arg);
    }
  }
  const targets = operands.map((arg) => webTarget(arg, cwd));
  if (targets.length === 0 || targets.every((target) => target === null)) {
    return passThrough("open", args);
  }
  const rest = operands.filter((_, index) => targets[index] === null);
  let status = await openAll(targets.filter(Boolean));
  if (rest.length > 0) {
    const code = passThrough("open", [...passFlags, ...rest]);
    if (code !== 0) status = code;
  }
  return status;
}

async function runXdgOpen(name, args) {
  if (args.length !== 1 || args[0].startsWith("-")) return passThrough(name, args);
  const target = webTarget(args[0], process.cwd());
  return target ? openInApp(target) : passThrough(name, args);
}

/** BROWSER: tools put their own arguments first and the URL last. */
async function runBrowser(args) {
  const arg = args.at(-1);
  if (!arg) {
    process.stderr.write("Usage: jagentdesk-browser <url>\\n");
    return 2;
  }
  const target = webTarget(arg, process.cwd()) || (/^[\\w.-]+:\\d+(?:\\/|$)/.test(arg) ? { url: "http://" + arg } : null);
  if (!target) {
    process.stderr.write("JAgentDesk opens only http(s) URLs and .html, .htm, .svg or .pdf files in its browser: " + arg + "\\n");
    return 2;
  }
  return openInApp(target);
}

async function main() {
  const mode = modeOf(process.argv[1]);
  const args = process.argv.slice(2);
  if (mode === "open") return runOpen(args);
  if (mode === "xdg-open" || mode === "explorer") return runXdgOpen(mode, args);
  return runBrowser(args);
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(String(error && error.message ? error.message : error) + "\\n");
    process.exit(1);
  },
);
`;
}
