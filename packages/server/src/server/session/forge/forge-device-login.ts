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

/** Strip ANSI escape sequences (gh/glab colorize their output). */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, "");
}

/** A device one-time code, e.g. `ABCD-1234` (two 4-char groups). */
const CODE_RE = /([A-Z0-9]{4}-[A-Z0-9]{4})/;
/** The verification URL the human opens, e.g. https://github.com/login/device. */
const URL_RE = /(https?:\/\/\S*?\/login\/device)/;
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
   * Optional per-chunk driver for CLIs that gate the web flow behind an
   * interactive menu (glab). Receives the ANSI-stripped accumulated output and a
   * `write` callback to answer a prompt. Called on every data chunk.
   */
  menuResponder?: (accumulated: string, write: (s: string) => void) => void;
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
      });
    }

    if (cli === "glab") {
      // Best-effort GitLab. `glab auth login` is menu-driven ("How would you like
      // to sign in?" → Web/Token), unlike gh's flag-driven flow, so it is far less
      // reliable to drive from a pty. We attempt it and reuse the same code/URL
      // parsing (glab's web flow also prints a device code + a `/login/device` URL);
      // `menuResponder` nudges the first sign-in-method prompt toward the default
      // (Enter). This path is UNVERIFIED against a live GitLab (see report); on any
      // failure the app falls back to the manual sign-in hint.
      let nudged = false;
      return this.driveLogin({
        forge,
        requestId,
        binPath,
        emitProgress,
        args: ["auth", "login", signIn.hostnameFlag ?? "--hostname", host || "gitlab.com"],
        envOverlay: { BROWSER: "true" },
        menuResponder: (accumulated, write) => {
          if (nudged) return;
          // glab presents a survey Select for the login method before printing a
          // code. Accept the highlighted default once when that prompt appears.
          if (/how would you like to (sign in|login)|select .*method/i.test(accumulated)) {
            nudged = true;
            write("\n");
          }
        },
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
    const { forge, requestId, binPath, args, envOverlay, menuResponder, emitProgress } = opts;
    return new Promise<LoginResult>((resolve) => {
      const env = createExternalCommandProcessEnv(binPath, process.env, envOverlay);

      let child: pty.IPty;
      try {
        child = pty.spawn(binPath, args, {
          name: "xterm-256color",
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

      const write = (s: string): void => {
        try {
          child.write(s);
        } catch {
          /* pty gone */
        }
      };

      // Look for the one-time code + verification URL. `text` may be a full line or
      // the un-terminated tail (gh prints the "Press Enter…" prompt without a \n).
      const inspect = (text: string): void => {
        if (codeEmitted) return;
        const cm = text.match(CODE_RE);
        if (!cm) return;
        const um = text.match(URL_RE);
        const userCode = cm[1] ?? null;
        const verificationUri = um ? (um[1] ?? null) : "https://github.com/login/device";
        codeEmitted = true;
        emitProgress({ phase: "awaiting_authorization", userCode, verificationUri });
        // Dismiss the CLI's "Press Enter to open in your browser…" prompt ONCE so it
        // proceeds to poll for authorization instead of waiting on stdin.
        write("\n");
      };

      const handleLine = (line: string): void => {
        const trimmed = line.trim();
        if (trimmed) lastLine = trimmed;
        inspect(line);
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
        // Inspect the un-terminated tail too (the code/prompt may lack a newline).
        const tail = stripAnsi(buffer);
        inspect(tail);
        accumulated += stripAnsi(data);
        menuResponder?.(accumulated, write);
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
