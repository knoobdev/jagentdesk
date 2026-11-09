// Remote shell snippets for spec 33. Every path that reaches a command line goes through the
// quoting helpers here; user-controlled bytes (command, delete lists, manifest) always travel
// over stdin, never inside the command string.

/** POSIX single-quote quoting: '…' with '\'' for embedded quotes. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function escapeDoubleQuoted(value: string): string {
  return value.replace(/([$`"\\])/g, "\\$1");
}

/**
 * Shell expression for a path under the target's workRoot. `~/` is resolved by the remote shell via
 * `$HOME` (spec 33.5); absolute paths are used as-is. The result is already quoted.
 */
export function remotePathExpr(workRoot: string, ...segments: readonly string[]): string {
  const suffix = segments.map((segment) => `/${segment}`).join("");
  if (workRoot === "~" || workRoot === "~/") {
    return `"$HOME${escapeDoubleQuoted(suffix)}"`;
  }
  if (workRoot.startsWith("~/")) {
    return `"$HOME/${escapeDoubleQuoted(`${workRoot.slice(2)}${suffix}`)}"`;
  }
  return shellQuote(`${workRoot}${suffix}`);
}

/** The user's login shell on the target, with the /bin/sh fallback from spec 33.6. */
const LOGIN_SHELL = "${SHELL:-/bin/sh}";

export const REMOTE_LAUNCHER_SCRIPT = [
  `"${LOGIN_SHELL}" -lc "$(cat "$1")" </dev/null >>"$2" 2>&1`,
  "ec=$?",
  `printf "%s" "$ec" >"$3.tmp" && mv "$3.tmp" "$3"`,
].join("\n");

/** Writes the job's command file from stdin; run before the launch script. */
export function buildWriteCommandScript(jobDirExpr: string): string {
  return `mkdir -p ${jobDirExpr} && cat > ${jobDirExpr}/command`;
}

/**
 * Launches the detached job (spec 33.6). The setsid'd shell is the process group leader; it runs
 * the login shell on the command, appends output to output.log and records the exit code atomically.
 * Its own pid lands in `pid` and doubles as the process group id.
 */
export function buildLaunchJobScript(input: { srcDirExpr: string; jobDirExpr: string }): string {
  const { srcDirExpr, jobDirExpr } = input;
  return [
    `cd ${srcDirExpr} || exit 3`,
    `setsid "${LOGIN_SHELL}" -c '${REMOTE_LAUNCHER_SCRIPT}' launcher ` +
      `${jobDirExpr}/command ${jobDirExpr}/output.log ${jobDirExpr}/exit_code ` +
      `</dev/null >/dev/null 2>&1 &`,
    `echo $! > ${jobDirExpr}/pid`,
  ].join("\n");
}

/**
 * One polling round: prints `EXIT <code>` when the job ended, `GONE` when neither the process group
 * nor the leader exists anymore and there is no exit code (spec 33.6 `lost`), then streams at most
 * `cap` new bytes of output.log starting at byte `offset` (1-based `tail -c`).
 */
export function buildPollScript(input: {
  jobDirExpr: string;
  offset: number;
  cap: number;
}): string {
  const { jobDirExpr, offset, cap } = input;
  return [
    // Status markers travel on stderr so log bytes on stdout can never collide with them.
    `if [ -f ${jobDirExpr}/exit_code ]; then { printf 'EXIT '; cat ${jobDirExpr}/exit_code; printf '\\n'; } >&2; fi`,
    `if [ ! -f ${jobDirExpr}/exit_code ]; then`,
    `  pid=$(cat ${jobDirExpr}/pid 2>/dev/null)`,
    `  if [ -n "$pid" ] && ! kill -0 -"$pid" 2>/dev/null && ! kill -0 -- -"$pid" 2>/dev/null && ! kill -0 "$pid" 2>/dev/null; then`,
    // A fast job can finish between the exit_code check above and these kill checks; re-check so a
    // completed job is never declared lost. The launcher writes exit_code before exiting, so a
    // dead process with no exit_code file can only be a launcher that never got to write one.
    `    if [ ! -f ${jobDirExpr}/exit_code ]; then`,
    `      printf 'GONE\\n' >&2`,
    `    fi`,
    `  fi`,
    `fi`,
    `tail -c +${offset + 1} ${jobDirExpr}/output.log 2>/dev/null | head -c ${cap}`,
  ].join("\n");
}

/** SIGTERM to the process group, 10 s grace, SIGKILL if still alive (spec 33.6). */
export function buildStopScript(input: { jobDirExpr: string }): string {
  const { jobDirExpr } = input;
  return [
    `pid=$(cat ${jobDirExpr}/pid 2>/dev/null)`,
    `if [ -n "$pid" ]; then`,
    `  kill -TERM -"$pid" 2>/dev/null || kill -TERM -- -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null`,
    `  i=0`,
    `  while [ "$i" -lt 20 ]; do`,
    `    if ! kill -0 -"$pid" 2>/dev/null && ! kill -0 -- -"$pid" 2>/dev/null && ! kill -0 "$pid" 2>/dev/null; then`,
    `      break`,
    `    fi`,
    `    sleep 0.5`,
    `    i=$((i+1))`,
    `  done`,
    `  if kill -0 -"$pid" 2>/dev/null || kill -0 -- -"$pid" 2>/dev/null || kill -0 "$pid" 2>/dev/null; then`,
    `    kill -KILL -"$pid" 2>/dev/null || kill -KILL -- -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null`,
    `  fi`,
    `fi`,
    `printf 'STOPPED\\n'`,
  ].join("\n");
}

/** Extracts the uploaded tar into src/ (stdin, gzip). */
export function buildExtractScript(srcDirExpr: string): string {
  return `mkdir -p ${srcDirExpr} && tar -xzf - -C ${srcDirExpr}`;
}

/** Deletes NUL-separated workspace-relative paths from src/ (stdin); never anything else. */
export function buildDeleteScript(srcDirExpr: string): string {
  return `cd ${srcDirExpr} && xargs -0 rm -rf --`;
}

/** Writes the new manifest from stdin atomically (temp + mv, spec 33.5). */
export function buildWriteManifestScript(manifestExpr: string): string {
  return `cat > ${manifestExpr}.tmp && mv ${manifestExpr}.tmp ${manifestExpr}`;
}

/** Prints the check-target report (spec 33.3) as parseable lines. */
export function buildCheckTargetScript(workRoot: string): string {
  const dir = remotePathExpr(workRoot);
  const probe = remotePathExpr(workRoot, ".jad-remote-exec-check");
  return [
    `uname -srm`,
    `printf 'SHELL %s\\n' "\${SHELL:-}"`,
    `for t in tar setsid kill mkdir rm cat; do command -v "$t" >/dev/null 2>&1 || printf 'MISSING %s\\n' "$t"; done`,
    `mkdir -p ${dir} 2>/dev/null`,
    `df -kP ${dir} 2>/dev/null | tail -n 1 | awk '{print $4}'`,
    `probe=${probe}`,
    `if touch "$probe" 2>/dev/null && rm -f "$probe" 2>/dev/null; then printf 'WRITABLE yes\\n'; else printf 'WRITABLE no\\n'; fi`,
  ].join("\n");
}
