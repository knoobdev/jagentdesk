import * as pty from "node-pty";
import { getForgeDefinition } from "@jagentdesk/protocol/forge-manifest";
import { findExecutable } from "../../../executable-resolution/executable-resolution.js";
import { createExternalCommandProcessEnv } from "../../jagentdesk-env.js";

/**
 * Forge Hub — app-driven device-flow sign-in (spec §19 / ADR-0015).
 *
 * Some forge CLIs (`gh`, `glab`) authenticate through an OAuth "device flow":
 * the CLI prints a one-time user code + a verification URL, the human opens that
 * URL on ANY device, enters the code, and the CLI completes once the server
 * confirms. The daemon drives the CLI inside a pty (the CLIs gate the web flow
 * behind an interactive prompt and emit color codes, so a plain pipe is not
 * enough) and streams the code / URL / progress to the app, which shows them so
 * the user can authorize from their phone or desktop without ever touching the
 * host machine.
 *
 * Binary resolution reuses {@link findExecutable} (the same PATH-augmented
 * resolution the rest of the daemon uses); the pty env is built with
 * {@link createExternalCommandProcessEnv} so the child's PATH finds
 * `/opt/homebrew/bin` etc. the same way {@link spawnProcess} does.
 *
 * Token-only forges (Bitbucket: `signIn === null`) have no device flow — they
 * resolve `error:"no-device-flow"` and the app falls back to token entry.
 */

const LOGIN_TIMEOUT_MS = 5 * 60_000;
// If the CLI hasn't printed a one-time code within this window, the device flow
// never started (e.g. glab's interactive menu we can't drive) — fail fast with a
// clear error instead of spinning on "Starting …" forever.
const NO_CODE_TIMEOUT_MS = 30_000;

/** Strip ANSI escape sequences (gh/glab colorize their output). */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, "");
}

// The one-time code, matched off the CLI's label so both formats work:
// gh prints "one-time code: 1A2B-3C4D" (dashed), glab "one-time code: SW63YQXV"
// (8 chars, no dash). Fall back to a bare dashed code if the label ever changes.
const CODE_LABEL_RE = /one-time code:\s*([A-Z0-9][A-Z0-9-]{4,14})/i;
const CODE_RE = /([A-Z0-9]{4}-[A-Z0-9]{4})/;
// The verification URL the human opens. gh: https://github.com/login/device,
// glab: https://gitlab.com/oauth/device — both contain "device".
const URL_RE = /(https?:\/\/[^\s]*device[^\s]*)/i;
/** A line that signals the CLI finished authenticating. */
const DONE_RE = /Authentication complete|Logged in as|Configured git/i;

/** Trim a CLI line to a short single-line error string. */
function shorten(line: string): string {
  const s = line.trim().replace(/\s+/g, " ");
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

/** FLAT progress event (the session wraps this with `type` + `requestId`). */
export interface LoginProgress {
  phase: "starting" | "awaiting_authorization" | "verifying" | "done" | "failed";
  userCode?: string | null;
  verificationUri?: string | null;
  line?: string | null;
}

export interface LoginResult {
  ok: boolean;
  forge: string;
  error?: string | null;
}

interface DriveOptions {
  forge: string;
  requestId: string;
  binPath: string;
  args: string[];
  /** Extra env overlaid on process.env for the child pty. */
  envOverlay: Record<string, string>;
  emitProgress: (progress: LoginProgress) => void;
  /**
   * Verification URL to show when the CLI prints a code but not the full URL
   * (gh relies on auto-opening the browser and only says "open github.com…").
   * Used as the fallback when no explicit device URL is parsed from output.
   */
  defaultVerificationUri: string;
  /**
   * TERM for the child pty. glab probes the terminal (OSC 11 background-color +
   * cursor-position queries) and BLOCKS waiting for responses node-pty never
   * sends, so it never prints the code. TERM=dumb disables that probing and it
   * prints plainly. gh works fine with a normal xterm.
   */
  term?: string;
}

export class ForgeDeviceLogin {
  /** Active login ptys keyed by the login's `requestId` so cancel can target one. */
  private readonly ptys = new Map<string, pty.IPty>();
  /** requestIds whose pty was killed by an explicit cancel (vs. a real failure). */
  private readonly cancelled = new Set<string>();

  /**
   * Drive a device-flow sign-in for `forge`. Emits many {@link LoginProgress}
   * events and resolves once with the terminal result. Never rejects.
   */
  async start(
    forge: string,
    host: string | undefined,
    requestId: string,
    emitProgress: (progress: LoginProgress) => void,
  ): Promise<LoginResult> {
    const signIn = getForgeDefinition(forge)?.signIn;
    // Token-only forge (e.g. Bitbucket) — no CLI device flow exists.
    if (!signIn) return { ok: false, forge, error: "no-device-flow" };

    const cli = signIn.cli;
    const binPath = await findExecutable(cli);
    if (!binPath) return { ok: false, forge, error: "cli-missing" };

    if (cli === "gh") {
      return this.driveLogin({
        forge,
        requestId,
        binPath,
        emitProgress,
        // BROWSER=true → gh runs `true` (a no-op that exits 0) instead of opening a
        // browser on the HOST, so the device flow stays entirely app-driven.
        // GH_PROMPT_DISABLED="" keeps prompting on (we WANT the device-code prompt);
        // the "Press Enter to open in your browser" line is dismissed below.
        args: [
          "auth",
          "login",
          "--hostname",
          host || "github.com",
          "--git-protocol",
          "https",
          "--web",
          "--skip-ssh-key",
        ],
        envOverlay: { BROWSER: "true", GH_PROMPT_DISABLED: "" },
        defaultVerificationUri: `https://${host || "github.com"}/login/device`,
      });
    }

    if (cli === "glab") {
      // GitLab via glab's OAuth 2.0 device flow (`--device`): flag-driven and
      // poll-based, exactly like gh — it prints "one-time code: XXXX" + the
      // https://gitlab.com/oauth/device URL, then waits. This is cross-device
      // (the code is entered on ANY browser), so it works from the app the same
      // way gh does. `--device` skips glab's interactive sign-in-method menu, so
      // no pty menu-nudging is needed. (Requires GitLab 17.9+ per glab docs.)
      return this.driveLogin({
        forge,
        requestId,
        binPath,
        emitProgress,
        // Pass every setup flag glab would otherwise PROMPT for before printing
        // the device code — without these it blocks on an interactive question
        // ("What domains does this host use for the container registry…?") in a
        // pty and never emits the code. Verified against glab 1.117.0 in node-pty.
        args: [
          "auth",
          "login",
          "--hostname",
          host || "gitlab.com",
          "--device",
          "--git-protocol",
          "https",
          "--api-protocol",
          "https",
          "--container-registry-domains",
          `registry.${host || "gitlab.com"}`,
        ],
        // TERM=dumb: glab otherwise probes the terminal and blocks (see `term`).
        envOverlay: { BROWSER: "true", TERM: "dumb", NO_COLOR: "1" },
        term: "dumb",
        defaultVerificationUri: `https://${host || "gitlab.com"}/oauth/device`,
      });
    }

    // Any other CLI (e.g. `tea` for Gitea/Forgejo/Codeberg) has no driver here.
    return { ok: false, forge, error: "unsupported-provider" };
  }

  /**
   * Cancel an in-flight login by `requestId`: kill its pty. The started login's
   * `onExit` then resolves `{ ok:false, error:"cancelled" }`. Returns true when a
   * matching pty was found and signalled.
   */
  cancel(targetRequestId: string): boolean {
    const child = this.ptys.get(targetRequestId);
    if (!child) return false;
    this.cancelled.add(targetRequestId);
    try {
      child.kill();
    } catch {
      /* already exited */
    }
    return true;
  }

  /** Spawn the CLI in a pty, parse its output, and resolve the terminal result. */
  private driveLogin(opts: DriveOptions): Promise<LoginResult> {
    const {
      forge,
      requestId,
      binPath,
      args,
      envOverlay,
      defaultVerificationUri,
      term,
      emitProgress,
    } = opts;
    return new Promise<LoginResult>((resolve) => {
      const env = createExternalCommandProcessEnv(binPath, process.env, envOverlay);

      let child: pty.IPty;
      try {
        child = pty.spawn(binPath, args, {
          name: term ?? "xterm-256color",
          cols: 120,
          rows: 40,
          env,
        });
      } catch (error) {
        return resolve({ ok: false, forge, error: shorten(String(error)) });
      }
      this.ptys.set(requestId, child);

      let settled = false;
      let buffer = "";
      let accumulated = "";
      let codeEmitted = false;
      let lastLine: string | null = null;

      emitProgress({ phase: "starting" });

      const finish = (result: LoginResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(codeTimer);
        this.ptys.delete(requestId);
        this.cancelled.delete(requestId);
        try {
          child.kill();
        } catch {
          /* already exited */
        }
        resolve(result);
      };

      const timer = setTimeout(() => {
        emitProgress({ phase: "failed", line: "timeout" });
        finish({ ok: false, forge, error: "timeout" });
      }, LOGIN_TIMEOUT_MS);

      // No one-time code within the window → the flow never really started.
      const codeTimer = setTimeout(() => {
        if (codeEmitted) return;
        emitProgress({ phase: "failed", line: "no-device-code" });
        finish({ ok: false, forge, error: "no-device-code" });
      }, NO_CODE_TIMEOUT_MS);

      const write = (s: string): void => {
        try {
          child.write(s);
        } catch {
          /* pty gone */
        }
      };

      // Scan the ACCUMULATED output (not a single line): gh and glab print the
      // one-time code and the URL on separate lines/bursts, and gh may not print
      // the full URL at all (it auto-opens the browser). Emit as soon as we have a
      // code; use the parsed device URL when present, else the per-forge default.
      const tryEmit = (accumulatedText: string): void => {
        if (codeEmitted) return;
        const cm = accumulatedText.match(CODE_LABEL_RE) ?? accumulatedText.match(CODE_RE);
        if (!cm) return;
        const um = accumulatedText.match(URL_RE);
        const userCode = cm[1] ?? null;
        const verificationUri = um?.[1] ?? defaultVerificationUri;
        codeEmitted = true;
        clearTimeout(codeTimer);
        emitProgress({ phase: "awaiting_authorization", userCode, verificationUri });
        // Dismiss the CLI's "Press Enter to open in your browser…" prompt ONCE so it
        // proceeds to poll for authorization instead of waiting on stdin.
        write("\n");
      };

      const handleLine = (line: string): void => {
        const trimmed = line.trim();
        if (trimmed) lastLine = trimmed;
        if (DONE_RE.test(line)) emitProgress({ phase: "verifying" });
      };

      child.onData((data: string) => {
        buffer += data;
        // Split on BOTH \n and \r: these CLIs redraw prompts with a bare \r.
        let idx: number;
        while ((idx = buffer.search(/[\r\n]/)) >= 0) {
          handleLine(stripAnsi(buffer.slice(0, idx)));
          buffer = buffer.slice(idx + 1);
        }
        // Scan the full accumulated output (incl. the un-terminated tail) so a
        // code and URL split across lines/chunks are both detected.
        accumulated += stripAnsi(data);
        tryEmit(accumulated + stripAnsi(buffer));
      });

      child.onExit((event: { exitCode: number }) => {
        // Flush any buffered partial line.
        if (buffer.trim()) handleLine(stripAnsi(buffer));
        buffer = "";
        if (settled) return;
        // Killed by an explicit cancel → report as cancelled, not a failure.
        if (this.cancelled.has(requestId)) {
          emitProgress({ phase: "failed", line: "cancelled" });
          finish({ ok: false, forge, error: "cancelled" });
          return;
        }
        if (event.exitCode === 0) {
          emitProgress({ phase: "done" });
          finish({ ok: true, forge });
          return;
        }
        emitProgress({ phase: "failed", line: lastLine });
        finish({
          ok: false,
          forge,
          error: lastLine ? shorten(lastLine) : `exit ${event.exitCode}`,
        });
      });
    });
  }
}
