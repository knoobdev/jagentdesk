import type {
  ServerDisk,
  ServerDocker,
  ServerEnvironment,
  ServerPackageManager,
  ServerSystemd,
  ServerTool,
} from "@jagentdesk/protocol/ssh/environment-schemas";
import { EnvironmentReportError, type EnvironmentReportInput } from "./types.js";

export const RUNNING_SERVICES_CAP = 200;

// One POSIX sh script, fed on stdin to a single `exec` channel (spec 25.10). It prints one
// `key=value` line per fact and `end=1` last, so a cut-off run is detectable. Works on GNU,
// BusyBox (Alpine) and macOS userlands; every probe tolerates a missing command.
// Version probes never contact a daemon (`docker --version`, `kubectl version --client`).
export const ENVIRONMENT_DETECT_SCRIPT = `
export LC_ALL=C
PATH="$PATH:/usr/local/bin:/usr/local/sbin:/usr/sbin:/sbin:/opt/homebrew/bin:/snap/bin"
p() { printf '%s=%s\\n' "$1" "$2"; }
first() { "$@" 2>&1 | head -n 1; }
has() { command -v "$1" >/dev/null 2>&1; }
p uname.s "$(uname -s 2>/dev/null)"
p uname.r "$(uname -r 2>/dev/null)"
p uname.m "$(uname -m 2>/dev/null)"
p hostname "$(hostname 2>/dev/null || uname -n 2>/dev/null)"
p shell "\${SHELL:-}"
if [ -r /etc/os-release ]; then sed -n 's/^\\([A-Z_][A-Z_]*\\)=/osr.\\1=/p' /etc/os-release; fi
if has nproc; then p cpu.cores "$(nproc 2>/dev/null)";
elif has getconf; then p cpu.cores "$(getconf _NPROCESSORS_ONLN 2>/dev/null)"; fi
if [ -r /proc/cpuinfo ]; then
  p cpu.model "$(sed -n 's/^model name[[:space:]]*:[[:space:]]*//p' /proc/cpuinfo | head -n 1)"
fi
if [ -r /proc/meminfo ]; then
  p mem.total_kb "$(sed -n 's/^MemTotal:[[:space:]]*\\([0-9]*\\).*/\\1/p' /proc/meminfo)"
  p mem.avail_kb "$(sed -n 's/^MemAvailable:[[:space:]]*\\([0-9]*\\).*/\\1/p' /proc/meminfo)"
fi
if [ "$(uname -s 2>/dev/null)" = Darwin ]; then
  p cpu.cores "$(sysctl -n hw.ncpu 2>/dev/null)"
  p cpu.model "$(sysctl -n machdep.cpu.brand_string 2>/dev/null)"
  p mem.total_bytes "$(sysctl -n hw.memsize 2>/dev/null)"
fi
p disk.df "$(df -Pk / 2>/dev/null | tail -n 1)"
if [ -r /proc/uptime ]; then p uptime.s "$(cut -d' ' -f1 /proc/uptime)"; fi
for t in docker podman systemctl psql mysql redis-cli nginx; do
  if has "$t"; then
    case "$t" in
      nginx) p "tool.$t" "$(first nginx -v)" ;;
      *) p "tool.$t" "$(first "$t" --version)" ;;
    esac
  fi
done
if has kubectl; then p tool.kubectl "$(first kubectl version --client)"; fi
for m in apt-get dnf yum apk brew pacman zypper; do if has "$m"; then p pm "$m"; fi; done
for s in "\${DOCKER_HOST#unix://}" /var/run/docker.sock "\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/docker.sock"; do
  if [ -n "$s" ] && [ -S "$s" ]; then
    p docker.socket "$s"
    if [ -r "$s" ] && [ -w "$s" ]; then p docker.access rw; else p docker.access denied; fi
    break
  fi
done
if [ -d /run/systemd/system ] && has systemctl; then
  p systemd 1
  systemctl list-units --type=service --state=running --no-legend --no-pager --plain 2>/dev/null \\
    | awk '{print "svc.running=" $1}' | head -n ${RUNNING_SERVICES_CAP + 1}
  systemctl list-units --type=service --state=failed --no-legend --no-pager --plain 2>/dev/null \\
    | awk '{print "svc.failed=" $1}' | head -n ${RUNNING_SERVICES_CAP}
fi
p end 1
`;

interface ReportLines {
  single: Map<string, string>;
  multi: Map<string, string[]>;
}

function splitReport(output: string): ReportLines {
  const single = new Map<string, string>();
  const multi = new Map<string, string[]>();
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1).trim();
    // Later probes refine earlier ones (macOS sysctl after the generic nproc), so last wins.
    single.set(key, value);
    const values = multi.get(key);
    if (values) values.push(value);
    else multi.set(key, [value]);
  }
  return { single, multi };
}

function nonEmpty(value: string | undefined): string | null {
  if (value === undefined || value.length === 0) return null;
  return value;
}

// os-release values may be quoted: NAME="Ubuntu" or NAME='Ubuntu'.
function unquote(value: string | undefined): string | null {
  const text = nonEmpty(value);
  if (text === null) return null;
  const quoted = /^(["'])(.*)\1$/.exec(text);
  return quoted ? quoted[2] : text;
}

function toNumber(value: string | undefined): number | null {
  const text = nonEmpty(value);
  if (text === null) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

// `df -Pk /` data line: filesystem, 1024-blocks, used, available, capacity, mount.
export function parseDfLine(line: string | undefined): ServerDisk | null {
  const text = nonEmpty(line);
  if (text === null) return null;
  const fields = text.split(/\s+/);
  if (fields.length < 6) return null;
  const totalKb = Number(fields[1]);
  const usedKb = Number(fields[2]);
  const availableKb = Number(fields[3]);
  const isNumeric = [totalKb, usedKb, availableKb].every(Number.isFinite);
  if (!isNumeric) return null;
  return {
    mount: fields.slice(5).join(" "),
    totalBytes: totalKb * 1024,
    usedBytes: usedKb * 1024,
    availableBytes: availableKb * 1024,
  };
}

function tool(lines: ReportLines, name: string): ServerTool | null {
  if (!lines.single.has(`tool.${name}`)) return null;
  return { version: nonEmpty(lines.single.get(`tool.${name}`)) };
}

function docker(lines: ReportLines): ServerDocker | null {
  const cli = tool(lines, "docker");
  const socketPath = nonEmpty(lines.single.get("docker.socket"));
  if (cli === null && socketPath === null) return null;
  return {
    version: cli?.version ?? null,
    socketPath,
    socketAccessible: lines.single.get("docker.access") === "rw",
  };
}

const PACKAGE_MANAGER_BY_COMMAND: Record<string, ServerPackageManager> = {
  "apt-get": "apt",
  dnf: "dnf",
  yum: "yum",
  apk: "apk",
  brew: "brew",
  pacman: "pacman",
  zypper: "zypper",
};

function packageManagers(lines: ReportLines): ServerPackageManager[] {
  const commands = lines.multi.get("pm") ?? [];
  return commands.flatMap((command) => {
    const manager = PACKAGE_MANAGER_BY_COMMAND[command];
    return manager ? [manager] : [];
  });
}

function systemd(lines: ReportLines): ServerSystemd | null {
  if (lines.single.get("systemd") !== "1") return null;
  const running = (lines.multi.get("svc.running") ?? []).filter((name) => name.length > 0);
  const failed = (lines.multi.get("svc.failed") ?? []).filter((name) => name.length > 0);
  return {
    runningServices: running.slice(0, RUNNING_SERVICES_CAP),
    failedServices: failed,
    runningTruncated: running.length > RUNNING_SERVICES_CAP,
  };
}

function memoryTotalBytes(lines: ReportLines): number | null {
  const bytes = toNumber(lines.single.get("mem.total_bytes"));
  if (bytes !== null) return bytes;
  const kb = toNumber(lines.single.get("mem.total_kb"));
  return kb === null ? null : kb * 1024;
}

function memoryAvailableBytes(lines: ReportLines): number | null {
  const kb = toNumber(lines.single.get("mem.avail_kb"));
  return kb === null ? null : kb * 1024;
}

function uptimeSeconds(lines: ReportLines): number | null {
  const seconds = toNumber(lines.single.get("uptime.s"));
  return seconds === null ? null : Math.floor(seconds);
}

/** Local EnvironmentReportParser; `ssh/environment-parse/` supplies the production one through the same type. */
export function parseEnvironmentReport(input: EnvironmentReportInput): ServerEnvironment {
  const lines = splitReport(input.output);
  if (lines.single.get("end") !== "1") throw new EnvironmentReportError("missing_end_marker");
  const kernelName = nonEmpty(lines.single.get("uname.s"));
  if (kernelName === null) throw new EnvironmentReportError("missing_uname");
  return {
    serverId: input.serverId,
    detectedAtMs: input.detectedAtMs,
    hostname: nonEmpty(lines.single.get("hostname")),
    os: {
      kernelName,
      kernelRelease: lines.single.get("uname.r") ?? "",
      arch: lines.single.get("uname.m") ?? "",
      distroId: unquote(lines.single.get("osr.ID")),
      distroName: unquote(lines.single.get("osr.NAME")),
      distroVersion: unquote(lines.single.get("osr.VERSION_ID")),
      prettyName: unquote(lines.single.get("osr.PRETTY_NAME")),
    },
    cpuCores: toNumber(lines.single.get("cpu.cores")),
    cpuModel: nonEmpty(lines.single.get("cpu.model")),
    memoryTotalBytes: memoryTotalBytes(lines),
    memoryAvailableBytes: memoryAvailableBytes(lines),
    rootDisk: parseDfLine(lines.single.get("disk.df")),
    uptimeSeconds: uptimeSeconds(lines),
    shell: nonEmpty(lines.single.get("shell")),
    docker: docker(lines),
    podman: tool(lines, "podman"),
    systemctl: tool(lines, "systemctl"),
    kubectl: tool(lines, "kubectl"),
    psql: tool(lines, "psql"),
    mysql: tool(lines, "mysql"),
    redisCli: tool(lines, "redis-cli"),
    nginx: tool(lines, "nginx"),
    packageManagers: packageManagers(lines),
    systemd: systemd(lines),
  };
}
