#!/usr/bin/env npx tsx

import assert from "node:assert";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "zx";
import { getAvailablePort } from "./helpers/network.ts";

$.verbose = false;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

console.log("=== Onboarding Command ===\n");

const jagentdeskHome = await mkdtemp(join(tmpdir(), "jagentdesk-onboard-home-"));
const port = await getAvailablePort();

try {
  console.log("Test 1: `jagentdesk` runs blocking onboarding without tailnet pairing");
  const onboard =
    await $`JAGENTDESK_HOME=${jagentdeskHome} JAGENTDESK_LISTEN=127.0.0.1:${port} JAGENTDESK_PAIRING_QR=0 npx jagentdesk`.nothrow();

  assert.strictEqual(
    onboard.exitCode,
    0,
    `onboard should succeed:\nstdout:\n${onboard.stdout}\nstderr:\n${onboard.stderr}`,
  );
  assert(
    onboard.stdout.includes("Tailnet pairing is not configured"),
    "onboard output should explain that tailnet pairing is not configured",
  );
  assert(!onboard.stdout.includes("Scan to pair"), "onboard output should not include scan header");
  assert(!onboard.stdout.includes("#offer="), "onboard output should not include a pairing offer");
  assert(
    onboard.stdout.includes("CLI quick reference"),
    "onboard output should include CLI quick reference",
  );
  assert(onboard.stdout.includes("jagentdesk --help"), "onboard output should include --help shortcut");
  assert(onboard.stdout.includes("jagentdesk ls"), "onboard output should include ls shortcut");
  assert(
    onboard.stdout.includes('jagentdesk run "your prompt"'),
    "onboard output should include run shortcut",
  );
  assert(onboard.stdout.includes("jagentdesk status"), "onboard output should include status shortcut");
  assert(
    onboard.stdout.includes(join(jagentdeskHome, "daemon.log")),
    "onboard output should include daemon log path",
  );

  const status =
    await $`JAGENTDESK_HOME=${jagentdeskHome} npx jagentdesk daemon status --home ${jagentdeskHome}`.nothrow();
  assert.strictEqual(status.exitCode, 0, `daemon status should succeed: ${status.stderr}`);
  assert(status.stdout.includes("running"), "daemon should be running when onboarding exits");
  console.log("✓ onboarding keeps tailnet pairing off and waits for daemon readiness\n");

  console.log("Test 2: tailnet pairing prints a pairing offer when the daemon has a tailnet host");
  const restart =
    await $`JAGENTDESK_HOME=${jagentdeskHome} JAGENTDESK_TAILNET_HOST=tailnet.test npx jagentdesk daemon restart --home ${jagentdeskHome} --listen 127.0.0.1:${port}`.nothrow();
  assert.strictEqual(
    restart.exitCode,
    0,
    `tailnet daemon restart should succeed: ${restart.stderr}`,
  );

  // The running daemon is authoritative for pairing, so the offer only appears
  // once the restarted daemon (started with JAGENTDESK_TAILNET_HOST) is reachable.
  let tailnetPair: Awaited<ReturnType<typeof $>> | null = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    tailnetPair =
      await $`JAGENTDESK_HOME=${jagentdeskHome} npx jagentdesk daemon pair --home ${jagentdeskHome}`.nothrow();
    if (tailnetPair.exitCode === 0 && tailnetPair.stdout.includes("#offer=")) break;
    await sleep(250);
  }
  assert.ok(tailnetPair, "tailnet pair should produce a result");
  assert.strictEqual(
    tailnetPair.exitCode,
    0,
    `tailnet pair should succeed: ${tailnetPair.stderr}`,
  );
  assert(
    tailnetPair.stdout.includes("Scan to pair"),
    "tailnet pair should include the scan-to-pair header",
  );
  assert(tailnetPair.stdout.includes("#offer="), "tailnet pair should produce a pairing offer");

  const tailnetOnboard =
    await $`JAGENTDESK_HOME=${jagentdeskHome} JAGENTDESK_LISTEN=127.0.0.1:${port} npx jagentdesk`.nothrow();
  assert.strictEqual(
    tailnetOnboard.exitCode,
    0,
    `tailnet onboarding should succeed: ${tailnetOnboard.stderr}`,
  );
  assert(
    tailnetOnboard.stdout.includes("#offer="),
    "tailnet onboarding should include a pairing offer",
  );
  console.log("✓ tailnet pairing prints an offer when JAGENTDESK_TAILNET_HOST is set\n");

  console.log("Test 3: non-interactive onboarding persists voice disabled config");
  const configRaw = await readFile(join(jagentdeskHome, "config.json"), "utf-8");
  const config = JSON.parse(configRaw) as {
    features?: {
      dictation?: { enabled?: boolean };
      voiceMode?: { enabled?: boolean };
    };
  };

  assert.strictEqual(
    config.features?.dictation?.enabled,
    false,
    "dictation.enabled should be false",
  );
  assert.strictEqual(
    config.features?.voiceMode?.enabled,
    false,
    "voiceMode.enabled should be false",
  );
  const daemonLog = await readFile(join(jagentdeskHome, "daemon.log"), "utf-8");
  assert(
    !daemonLog.includes("Ensuring local speech models"),
    "daemon should not attempt local speech model setup when voice is disabled",
  );
  console.log("✓ non-interactive run persisted voice disabled choices\n");
} finally {
  await $`JAGENTDESK_HOME=${jagentdeskHome} npx jagentdesk daemon stop --home ${jagentdeskHome} --force`.nothrow();
  await rm(jagentdeskHome, { recursive: true, force: true });
}

console.log("=== Onboarding tests passed ===");
