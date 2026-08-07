import { mkdtemp, open, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  acquirePidLock,
  getPidLockInfo,
  isLocked,
  PidLockError,
  refreshPidLock,
  releasePidLock,
  updatePidLock,
} from "./pid-lock.js";

describe("pid-lock ownership", () => {
  test("writes and releases lock for explicit owner pid", async () => {
    const jagentdeskHome = await mkdtemp(join(tmpdir(), "jagentdesk-pid-lock-owner-"));
    const ownerPid = process.pid + 10_000;

    try {
      await (
        acquirePidLock as unknown as (
          home: string,
          sockPath: string | null,
          options: { ownerPid: number },
        ) => Promise<void>
      )(jagentdeskHome, null, { ownerPid });

      const lock = await getPidLockInfo(jagentdeskHome);
      expect(lock?.pid).toBe(ownerPid);
      expect(lock?.listen).toBeNull();
      expect(lock?.heartbeat).toBe(true);

      await (
        updatePidLock as unknown as (
          home: string,
          patch: { listen: string },
          options: { ownerPid: number },
        ) => Promise<void>
      )(jagentdeskHome, { listen: "127.0.0.1:6767" }, { ownerPid });

      const updatedLock = await getPidLockInfo(jagentdeskHome);
      expect(updatedLock?.listen).toBe("127.0.0.1:6767");

      await (
        releasePidLock as unknown as (home: string, options: { ownerPid: number }) => Promise<void>
      )(jagentdeskHome, { ownerPid: ownerPid + 1 });
      const lockAfterWrongOwnerRelease = await getPidLockInfo(jagentdeskHome);
      expect(lockAfterWrongOwnerRelease?.pid).toBe(ownerPid);

      await (
        releasePidLock as unknown as (home: string, options: { ownerPid: number }) => Promise<void>
      )(jagentdeskHome, { ownerPid });
      const lockAfterOwnerRelease = await getPidLockInfo(jagentdeskHome);
      expect(lockAfterOwnerRelease).toBeNull();
    } finally {
      await rm(jagentdeskHome, { recursive: true, force: true });
    }
  });

  test("keeps a stale heartbeat lock when the recorded pid is alive without a reachability check", async () => {
    const jagentdeskHome = await mkdtemp(join(tmpdir(), "jagentdesk-pid-lock-stale-heartbeat-"));
    const replacementOwnerPid = process.pid + 10_000;

    try {
      const pidPath = join(jagentdeskHome, "jagentdesk.pid");
      await writeFile(
        pidPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: "2026-01-01T00:00:00.000Z",
          hostname: "old-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
          heartbeat: true,
        }),
      );
      const staleTime = new Date(Date.now() - 10 * 60_000);
      await utimes(pidPath, staleTime, staleTime);

      await expect(isLocked(jagentdeskHome)).resolves.toMatchObject({ locked: true });
      await expect(
        acquirePidLock(jagentdeskHome, null, { ownerPid: replacementOwnerPid }),
      ).rejects.toThrow("Another JAgentDesk daemon is already running");

      const lock = await getPidLockInfo(jagentdeskHome);
      expect(lock?.pid).toBe(process.pid);
    } finally {
      await rm(jagentdeskHome, { recursive: true, force: true });
    }
  });

  test("reclaims a stale desktop heartbeat lock after desktop confirms the daemon is unreachable", async () => {
    const jagentdeskHome = await mkdtemp(join(tmpdir(), "jagentdesk-pid-lock-stale-desktop-heartbeat-"));
    const replacementOwnerPid = process.pid + 10_000;

    try {
      const pidPath = join(jagentdeskHome, "jagentdesk.pid");
      await writeFile(
        pidPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: "2026-01-01T00:00:00.000Z",
          hostname: "old-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
          heartbeat: true,
        }),
      );
      const staleTime = new Date(Date.now() - 10 * 60_000);
      await utimes(pidPath, staleTime, staleTime);

      await acquirePidLock(jagentdeskHome, null, {
        ownerPid: replacementOwnerPid,
        reclaimStaleDesktopLock: true,
      });

      const lock = await getPidLockInfo(jagentdeskHome);
      expect(lock?.pid).toBe(replacementOwnerPid);
      expect(lock?.listen).toBeNull();
    } finally {
      await rm(jagentdeskHome, { recursive: true, force: true });
    }
  });

  test("keeps a stale live lock written by a pre-heartbeat daemon", async () => {
    const jagentdeskHome = await mkdtemp(join(tmpdir(), "jagentdesk-pid-lock-legacy-live-"));
    const pidPath = join(jagentdeskHome, "jagentdesk.pid");

    try {
      await writeFile(
        pidPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: "2026-01-01T00:00:00.000Z",
          hostname: "old-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
        }),
      );
      const staleTime = new Date(Date.now() - 10 * 60_000);
      await utimes(pidPath, staleTime, staleTime);

      await expect(
        acquirePidLock(jagentdeskHome, null, { ownerPid: process.pid + 10_000 }),
      ).rejects.toThrow("Another JAgentDesk daemon is already running");

      const lock = await getPidLockInfo(jagentdeskHome);
      expect(lock?.pid).toBe(process.pid);
    } finally {
      await rm(jagentdeskHome, { recursive: true, force: true });
    }
  });

  test("reclaims a stale legacy desktop lock after desktop confirms the daemon is unreachable", async () => {
    const jagentdeskHome = await mkdtemp(join(tmpdir(), "jagentdesk-pid-lock-legacy-desktop-"));
    const replacementOwnerPid = process.pid + 10_000;
    const pidPath = join(jagentdeskHome, "jagentdesk.pid");

    try {
      await writeFile(
        pidPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: "2026-01-01T00:00:00.000Z",
          hostname: "old-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
        }),
      );
      const staleTime = new Date(Date.now() - 10 * 60_000);
      await utimes(pidPath, staleTime, staleTime);

      await acquirePidLock(jagentdeskHome, null, {
        ownerPid: replacementOwnerPid,
        reclaimStaleDesktopLock: true,
      });

      const lock = await getPidLockInfo(jagentdeskHome);
      expect(lock?.pid).toBe(replacementOwnerPid);
      expect(lock?.heartbeat).toBe(true);
    } finally {
      await rm(jagentdeskHome, { recursive: true, force: true });
    }
  });

  test("rejects a heartbeat refresh after another supervisor takes ownership", async () => {
    const jagentdeskHome = await mkdtemp(join(tmpdir(), "jagentdesk-pid-lock-refresh-owner-"));

    try {
      await acquirePidLock(jagentdeskHome, null, { ownerPid: process.pid + 10_000 });

      await expect(refreshPidLock(jagentdeskHome, { ownerPid: process.pid })).rejects.toBeInstanceOf(
        PidLockError,
      );
    } finally {
      await rm(jagentdeskHome, { recursive: true, force: true });
    }
  });

  test("retries a heartbeat refresh while its owner is rewriting the lock", async () => {
    const jagentdeskHome = await mkdtemp(join(tmpdir(), "jagentdesk-pid-lock-refresh-rewrite-"));
    const pidPath = join(jagentdeskHome, "jagentdesk.pid");

    try {
      await acquirePidLock(jagentdeskHome, null, { ownerPid: process.pid });
      const lock = await getPidLockInfo(jagentdeskHome);
      expect(lock).not.toBeNull();

      const rewriteHandle = await open(pidPath, "r+");
      await rewriteHandle.truncate(0);

      const refresh = refreshPidLock(jagentdeskHome, { ownerPid: process.pid });
      await new Promise((resolve) => setTimeout(resolve, 250));
      await rewriteHandle.writeFile(JSON.stringify(lock));
      await rewriteHandle.close();

      await expect(refresh).resolves.toBeUndefined();
    } finally {
      await rm(jagentdeskHome, { recursive: true, force: true });
    }
  });

  test("keeps a fresh lock when the recorded pid is alive", async () => {
    const jagentdeskHome = await mkdtemp(join(tmpdir(), "jagentdesk-pid-lock-fresh-heartbeat-"));

    try {
      await writeFile(
        join(jagentdeskHome, "jagentdesk.pid"),
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          hostname: "current-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
          heartbeat: true,
        }),
      );

      await expect(
        acquirePidLock(jagentdeskHome, null, { ownerPid: process.pid + 10_000 }),
      ).rejects.toThrow("Another JAgentDesk daemon is already running");

      const lock = await getPidLockInfo(jagentdeskHome);
      expect(lock?.pid).toBe(process.pid);
      expect(lock?.listen).toBe("127.0.0.1:6767");
    } finally {
      await rm(jagentdeskHome, { recursive: true, force: true });
    }
  });
});
