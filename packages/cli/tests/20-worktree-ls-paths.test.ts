#!/usr/bin/env npx tsx

import assert from "node:assert";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveJAgentDeskHomePath, resolveJAgentDeskWorktreesDir } from "../src/commands/worktree/ls.js";

console.log("=== Worktree LS Path Helper Tests ===\n");

const originalJAgentDeskHome = process.env.JAGENTDESK_HOME;

try {
  {
    console.log("Test 1: resolves explicit JAGENTDESK_HOME when set");
    process.env.JAGENTDESK_HOME = "/tmp/jagentdesk-explicit-home";

    assert.strictEqual(resolveJAgentDeskHomePath(), "/tmp/jagentdesk-explicit-home");
    assert.strictEqual(resolveJAgentDeskWorktreesDir(), "/tmp/jagentdesk-explicit-home/worktrees");
    console.log("\u2713 explicit JAGENTDESK_HOME is respected\n");
  }

  {
    console.log("Test 2: falls back to homedir/.jagentdesk when JAGENTDESK_HOME is unset");
    delete process.env.JAGENTDESK_HOME;

    assert.strictEqual(resolveJAgentDeskHomePath(), join(homedir(), ".jagentdesk"));
    assert.strictEqual(resolveJAgentDeskWorktreesDir(), join(homedir(), ".jagentdesk", "worktrees"));
    console.log("\u2713 fallback home path is derived from os.homedir()\n");
  }
} finally {
  if (originalJAgentDeskHome === undefined) {
    delete process.env.JAGENTDESK_HOME;
  } else {
    process.env.JAGENTDESK_HOME = originalJAgentDeskHome;
  }
}

console.log("=== All worktree ls path helper tests passed ===");
