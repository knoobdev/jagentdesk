import type { ServerEnvironment } from "@jagentdesk/protocol/ssh/environment-schemas";

// The seam between detection (this module: run ENVIRONMENT_DETECT_SCRIPT on one exec channel)
// and parsing its output (`ssh/environment-parse/` replaces the local parser in detect.ts).
//
// Report format printed by ENVIRONMENT_DETECT_SCRIPT on stdout, one fact per line, `key=value`
// split at the first "=", values trimmed, unknown keys ignored, `end=1` always last:
//   uname.s / uname.r / uname.m   `uname -s` / `-r` / `-m`
//   hostname, shell               hostname, $SHELL
//   osr.<KEY>                     each /etc/os-release line, value as written (may be quoted)
//   cpu.cores, cpu.model          may repeat; the last line wins (macOS sysctl after nproc)
//   mem.total_kb, mem.avail_kb    /proc/meminfo MemTotal / MemAvailable (kB)
//   mem.total_bytes               macOS hw.memsize
//   disk.df                       data line of `df -Pk /`
//   uptime.s                      first field of /proc/uptime (seconds, fractional)
//   tool.<name>                   present on PATH; value = first line of its version output
//                                 (docker podman systemctl kubectl psql mysql redis-cli nginx)
//   pm                            repeated: apt-get dnf yum apk brew pacman zypper
//   docker.socket, docker.access  first Docker socket found; access "rw" or "denied"
//   systemd                       "1" when booted with systemd
//   svc.running, svc.failed       repeated unit names (running capped at RUNNING_SERVICES_CAP+1)
//   end                           "1"

export interface EnvironmentReportInput {
  serverId: string;
  output: string;
  detectedAtMs: number;
}

/** Turns a report into a ServerEnvironment; throws EnvironmentReportError when it is not one. */
export type EnvironmentReportParser = (input: EnvironmentReportInput) => ServerEnvironment;

export class EnvironmentReportError extends Error {
  constructor(readonly reason: "missing_end_marker" | "missing_uname") {
    super(`environment report is incomplete: ${reason}`);
    this.name = "EnvironmentReportError";
  }
}
