#!/usr/bin/env npx tsx

/**
 * Phase 2: Daemon Command Tests
 *
 * Tests daemon commands with an isolated JAGENTDESK_HOME.
 *
 * Tests:
 * - daemon --help shows subcommands
 * - daemon pair requires tailnet pairing to be configured
 * - daemon status reports stopped when daemon not running
 * - daemon status --json outputs valid JSON
 * - daemon stop handles daemon not running gracefully
 * - daemon restart starts the daemon and can be cleaned up
 * - daemon status and pairing use JAGENTDESK_TAILNET_HOST when set
 */

import assert from "node:assert";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { runLocalJAgentDesk } from "./helpers/local-cli.ts";

console.log("=== Daemon Commands ===\n");

// Keep restart off default 6767 to avoid collisions with any existing daemon.
const port = 10000 + Math.floor(Math.random() * 50000);
const jagentdeskHome = await mkdtemp(join(tmpdir(), "jagentdesk-test-home-"));

function daemonCommand(args: string[]) {
  return runLocalJAgentDesk(["daemon", ...args], { JAGENTDESK_HOME: jagentdeskHome });
}

try {
  // Test 1: daemon --help shows subcommands
  {
    console.log("Test 1: daemon --help shows subcommands");
    const result = await runLocalJAgentDesk(["daemon", "--help"]);
    assert.strictEqual(result.exitCode, 0, "daemon --help should exit 0");
    assert(result.stdout.includes("start"), "help should mention start");
    assert(result.stdout.includes("status"), "help should mention status");
    assert(result.stdout.includes("stop"), "help should mention stop");
    assert(result.stdout.includes("restart"), "help should mention restart");
    assert(result.stdout.includes("pair"), "help should mention pair");
    console.log("✓ daemon --help shows subcommands\n");
  }

  // Test 2: daemon pair requires tailnet pairing to be configured
  {
    console.log("Test 2: daemon pair requires tailnet pairing to be configured");
    const result = await daemonCommand(["pair"]);
    assert.strictEqual(result.exitCode, 1, "daemon pair should fail without a tailnet host");
    assert(
      result.stderr.includes("Tailnet pairing is not configured for this daemon"),
      "output should explain that tailnet pairing is not configured",
    );
    assert(!result.stdout.includes("#offer="), "output should not include a pairing offer");
    console.log("✓ daemon pair requires tailnet pairing to be configured\n");
  }

  // Test 3: daemon status reports stopped when daemon not running
  {
    console.log("Test 3: daemon status reports stopped when not running");
    const result = await daemonCommand(["status"]);
    assert.strictEqual(result.exitCode, 0, "status should succeed when daemon is stopped");
    const output = result.stdout.toLowerCase();
    assert(output.includes("local daemon"), "status table should include Local Daemon row");
    assert(output.includes("stopped"), "status should report stopped");
    console.log("✓ daemon status reports stopped when not running\n");
  }

  // Test 4: daemon pair --json exposes the machine-readable not-configured state
  {
    console.log("Test 4: daemon pair --json reports tailnet not configured");
    const result = await daemonCommand(["pair", "--json"]);
    assert.strictEqual(result.exitCode, 1, "daemon pair --json should fail without a tailnet host");
    const errorLine = result.stderr.split("\n").find((line) => line.startsWith("{"));
    assert(errorLine, "stderr should include a structured error");
    const error = JSON.parse(errorLine);
    assert.strictEqual(error.code, "TAILNET_NOT_CONFIGURED", "error should identify tailnet state");
    assert(!result.stdout.includes("#offer="), "output should not include a pairing offer");
    console.log("✓ daemon pair --json reports tailnet not configured\n");
  }

  // Test 5: daemon status --json outputs valid JSON
  {
    console.log("Test 5: daemon status --json outputs JSON");
    const result = await daemonCommand(["status", "--json"]);
    assert.strictEqual(result.exitCode, 0, "--json status should succeed");
    const status = JSON.parse(result.stdout);
    assert.strictEqual(typeof status.serverId, "string", "json status should include serverId");
    assert.strictEqual(status.localDaemon, "stopped", "json status should report stopped");
    assert.strictEqual(status.home, jagentdeskHome, "json status should reflect the isolated home");
    assert.strictEqual(
      status.hostname,
      null,
      "json status should include hostname when unavailable",
    );
    console.log("✓ daemon status --json outputs valid JSON\n");
  }

  // Test 6: daemon stop handles daemon not running gracefully
  {
    console.log("Test 6: daemon stop handles daemon not running");
    const result = await daemonCommand(["stop"]);
    // Stop should succeed even if daemon is not running (idempotent).
    assert.strictEqual(result.exitCode, 0, "stop should succeed when daemon not running");
    const output = result.stdout + result.stderr;
    const mentionsNotRunning =
      output.toLowerCase().includes("not running") ||
      output.toLowerCase().includes("was not running");
    assert(mentionsNotRunning, "output should mention daemon was not running");
    console.log("✓ daemon stop succeeds gracefully when daemon not running\n");
  }

  // Test 7: daemon restart starts daemon and can be stopped
  {
    console.log("Test 7: daemon restart starts daemon and can be stopped");
    const result = await daemonCommand(["restart", "--port", String(port)]);
    assert.strictEqual(result.exitCode, 0, "restart should succeed even when previously stopped");
    assert(result.stdout.toLowerCase().includes("restarted"), "output should report restart");

    const cleanup = await daemonCommand(["stop", "--force"]);
    assert.strictEqual(cleanup.exitCode, 0, "cleanup stop should succeed after restart");
    console.log("✓ daemon restart starts and stop cleanup succeeds\n");
  }

  // Test 8: status and pairing use the tailnet host from JAGENTDESK_TAILNET_HOST
  {
    console.log("Test 8: daemon status and pairing use JAGENTDESK_TAILNET_HOST");
    const listenPort = 10000 + Math.floor(Math.random() * 50000);
    const listen = `127.0.0.1:${listenPort}`;
    const tailnetEnv = { JAGENTDESK_HOME: jagentdeskHome, JAGENTDESK_TAILNET_HOST: "tailnet.test" };
    const start = await runLocalJAgentDesk(["daemon", "start", "--listen", listen], tailnetEnv);
    assert.strictEqual(start.exitCode, 0, `tailnet daemon should start: ${start.stderr}`);

    // Wait for the daemon to become reachable over the configured listen target.
    const deadline = Date.now() + 30_000;
    for (;;) {
      const probe = await runLocalJAgentDesk(["daemon", "status", "--json"], tailnetEnv);
      if (probe.exitCode === 0 && JSON.parse(probe.stdout).connectedDaemon === "reachable") break;
      if (Date.now() >= deadline) {
        throw new Error(`tailnet daemon did not become reachable within 30s: ${probe.stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    const status = await runLocalJAgentDesk(["daemon", "status", "--json"], tailnetEnv);
    assert.strictEqual(status.exitCode, 0, `tailnet status should succeed: ${status.stderr}`);
    assert(status.stdout.includes("tailnet.test"), "status should show the tailnet host");

    const pairing = await runLocalJAgentDesk(["daemon", "pair", "--json"], tailnetEnv);
    assert.strictEqual(pairing.exitCode, 0, `tailnet pairing should succeed: ${pairing.stderr}`);
    const payload = JSON.parse(pairing.stdout);
    assert.strictEqual(payload.tailnetEnabled, true, "pairing should report tailnet enabled");
    assert.match(payload.url, /#offer=/, "pairing should include a tailnet offer");

    const cleanup = await daemonCommand(["stop", "--force"]);
    assert.strictEqual(cleanup.exitCode, 0, "cleanup stop should succeed after tailnet status");
    console.log("✓ daemon status and pairing use JAGENTDESK_TAILNET_HOST\n");
  }
} finally {
  // Best-effort daemon cleanup in case assertions fail before explicit stop.
  await daemonCommand(["stop", "--force"]);
  // Clean up temp directory
  await rm(jagentdeskHome, { recursive: true, force: true });
}

console.log("=== All daemon tests passed ===");
