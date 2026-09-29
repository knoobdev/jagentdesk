#!/usr/bin/env npx tsx

import assert from "node:assert";
import { runLocalJAgentDesk } from "./helpers/local-cli.ts";
import { startTestDaemon } from "./helpers/test-daemon.ts";

console.log("=== Daemon Auth Command Errors ===\n");

const daemon = await startTestDaemon({
  env: { JAGENTDESK_PASSWORD: "shared-secret" },
});

async function lsError(password: string) {
  const result = await runLocalJAgentDesk(["ls", "--json"], {
    JAGENTDESK_HOME: daemon.jagentdeskHome,
    // The CLI in this fork does not discover a daemon's listen address from its pid file,
    // so point it at the test daemon explicitly.
    JAGENTDESK_HOST: `localhost:${daemon.port}`,
    JAGENTDESK_PASSWORD: password,
  });
  assert.notStrictEqual(result.exitCode, 0, "ls should fail without a valid password");
  return JSON.parse(result.stderr).error as {
    code: string;
    message: string;
    details: string;
  };
}

try {
  {
    console.log("Test 1: missing password asks for JAGENTDESK_PASSWORD, not a daemon start");
    const error = await lsError("");
    assert.strictEqual(error.code, "AUTH_REQUIRED");
    assert.match(error.message, /Password required/);
    assert.match(error.details, /JAGENTDESK_PASSWORD/);
    assert.doesNotMatch(error.details, /daemon start/);
    console.log("✓ missing password points at JAGENTDESK_PASSWORD\n");
  }

  {
    console.log("Test 2: wrong password asks for JAGENTDESK_PASSWORD, not a daemon start");
    const error = await lsError("wrong-secret");
    assert.strictEqual(error.code, "AUTH_FAILED");
    assert.match(error.message, /Incorrect password/);
    assert.match(error.details, /JAGENTDESK_PASSWORD/);
    assert.doesNotMatch(error.details, /daemon start/);
    console.log("✓ wrong password points at JAGENTDESK_PASSWORD\n");
  }
} finally {
  await daemon.stop();
}

console.log("=== Daemon Auth Command Errors Tests Passed ===");
