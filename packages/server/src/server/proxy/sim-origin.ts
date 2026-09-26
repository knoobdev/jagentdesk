import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

// System-proxy capture is Mac-wide: iOS Simulators have no independent network stack, so the only way
// they honour a proxy is via the host's system proxy — which also routes the user's own browser. To
// keep capture scoped to a single simulator we resolve the OS process behind each proxy connection's
// source port and record the transaction only when that process belongs to the target device. The
// host's other traffic still passes through the proxy untouched; it is simply not stored.
//
// A simulator's traffic egresses from its per-device runtime process, whose *command line* is the
// shared runtime executable (no UDID) — but it holds files open under the device's data root
// `/Devices/<UDID>/`. So we identify the device's PIDs by their open files (lsof), not by command,
// then map an incoming ephemeral source port to its owning PID. Both lookups are cached briefly so a
// capture burst does not shell out per request.

export type OriginFilter = (originPort: number) => Promise<boolean>;

export function makeSimOriginFilter(udid: string): OriginFilter {
  let simPids = new Set<number>();
  let pidsAt = 0;
  const PID_TTL_MS = 3000;
  const decisionCache = new Map<number, { ok: boolean; at: number }>();
  const DECISION_TTL_MS = 5000;

  async function simPidSet(): Promise<Set<number>> {
    const now = Date.now();
    if (simPids.size > 0 && now - pidsAt < PID_TTL_MS) return simPids;
    try {
      // -Fpn machine format: `p<pid>` starts a process block, `n<path>` is each open file. Any process
      // with a file under this device's dir is one of the device's processes (incl. the runtime that
      // owns its sockets).
      const { stdout } = await pexec("/usr/sbin/lsof", ["-nP", "-w", "-Fpn"], {
        maxBuffer: 128 * 1024 * 1024,
      });
      const needle = `/Devices/${udid}/`;
      const next = new Set<number>();
      let cur = 0;
      for (const line of stdout.split("\n")) {
        if (line.startsWith("p")) {
          const n = Number(line.slice(1));
          cur = Number.isNaN(n) ? 0 : n;
        } else if (cur && line.startsWith("n") && line.includes(needle)) {
          next.add(cur);
        }
      }
      if (next.size > 0) {
        simPids = next;
        pidsAt = now;
      }
    } catch {
      // Keep the previous set on a transient failure rather than dropping all sim traffic.
    }
    return simPids;
  }

  async function pidsForPort(port: number): Promise<number[]> {
    try {
      const { stdout } = await pexec(
        "/usr/sbin/lsof",
        ["-nP", `-iTCP:${port}`, "-sTCP:ESTABLISHED", "-Fp"],
        { maxBuffer: 4 * 1024 * 1024 },
      );
      const pids: number[] = [];
      for (const line of stdout.split("\n")) {
        if (line.startsWith("p")) {
          const n = Number(line.slice(1));
          if (!Number.isNaN(n)) pids.push(n);
        }
      }
      return pids;
    } catch {
      return [];
    }
  }

  return async (originPort: number): Promise<boolean> => {
    if (!originPort) return false;
    const now = Date.now();
    const cached = decisionCache.get(originPort);
    if (cached && now - cached.at < DECISION_TTL_MS) return cached.ok;
    const [sims, owners] = await Promise.all([simPidSet(), pidsForPort(originPort)]);
    const ok = owners.some((pid) => sims.has(pid));
    decisionCache.set(originPort, { ok, at: now });
    return ok;
  };
}
