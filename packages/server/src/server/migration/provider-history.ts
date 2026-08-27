import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { Logger } from "pino";
import {
  HISTORY_BLOB_MAX_FILE_BYTES,
  type HistoryBlob,
  type HistoryBlobFile,
} from "@jagentdesk/protocol/migration/host-data-bundle";

import { claudeProjectDir } from "../agent/providers/claude/project-dir.js";

// ─────────────────────────────────────────────────────────────────────────────
// Provider conversation-history portability.
//
// The daemon does not store conversation history — each provider CLI keeps its
// own on-disk transcript. To move an agent to another daemon we (a) locate those
// files on the SOURCE machine and copy their bytes INLINE into the bundle, then
// (b) write them back into the provider's storage on the TARGET so that
// `resumeSession` can rehydrate the timeline.
//
// Cross-machine (b) works when the daemon can reproduce the provider's on-disk
// layout deterministically AND rewrite the machine-local absolute paths the
// transcript embeds (source cwd/home → target cwd/home). Today that is only
// Claude: `claudeProjectDir` is a verbatim port of the Claude Agent SDK's
// project-dir encoder, so we know the exact `<sessionId>.jsonl` path on both
// ends. History then crosses machines as long as the target cwd exists on disk;
// if it does not, the session cannot resume there and we refuse to fake success
// (`materializeProviderHistory` returns `{ ok: false }` and the caller flags the
// agent's history as unavailable).
//
// Providers NOT covered (record-only, `historyPortable: false`):
//   - codex: sessions ("threads") are enumerated and resumed exclusively through
//     the Codex app-server RPC (`thread/list`, resume by threadId). The rollout
//     transcripts live under `~/.codex/sessions` but are date-partitioned
//     (`YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`) and the uuid is NOT the
//     threadId — there is no in-repo encoder mapping (cwd, threadId) → file path,
//     so we cannot confidently locate the file to copy. Guessing the path risks
//     bundling the wrong session, so codex history stays record-only.
//   - opencode: sessions are enumerated and resumed exclusively through the
//     OpenCode HTTP server SDK (`session.get` / `session.messages`). Storage is
//     internal to the opencode server process and keyed by project; the daemon
//     never computes a session-file path, so we cannot locate the bytes to copy.
//     opencode history stays record-only.
// ─────────────────────────────────────────────────────────────────────────────

const CLAUDE_PROVIDER_ID = "claude";

/**
 * True only for providers whose transcript file the daemon can locate AND whose
 * on-disk layout it can reproduce on the target. See the module header for why
 * codex and opencode are excluded.
 */
export function isHistoryLocatableProvider(provider: string): boolean {
  return provider === CLAUDE_PROVIDER_ID;
}

/** Snapshot the current machine's home so the target can rewrite source paths. */
export function currentSourceHome(): string {
  return homedir();
}

/**
 * Absolute paths of the provider session files backing `sessionId` for `cwd`, as
 * they exist on THIS machine. Returns `[]` when the provider is unsupported or no
 * file is present.
 */
async function locateProviderHistoryFiles(input: {
  provider: string;
  cwd: string;
  sessionId: string;
}): Promise<string[]> {
  if (!isHistoryLocatableProvider(input.provider)) {
    return [];
  }
  // Claude stores one JSONL transcript per session under the encoded project dir.
  const projectDir = await claudeProjectDir(input.cwd);
  const sessionFile = path.join(projectDir, `${input.sessionId}.jsonl`);
  try {
    await fs.access(sessionFile);
    return [sessionFile];
  } catch {
    return [];
  }
}

/**
 * Read the provider history for an agent into a portable blob. Best-effort:
 * returns null when nothing is readable (unsupported provider, missing file,
 * or read error). Never throws. Transcripts larger than
 * HISTORY_BLOB_MAX_FILE_BYTES are recorded as `omitted` (no bytes) so a single
 * huge session cannot bloat the bundle.
 */
export async function captureProviderHistory(input: {
  provider: string;
  cwd: string;
  sessionId: string;
  logger: Logger;
}): Promise<HistoryBlob | null> {
  try {
    const files = await locateProviderHistoryFiles(input);
    if (files.length === 0) {
      return null;
    }
    const contents = await Promise.all(
      files.map(async (filePath): Promise<HistoryBlobFile> => {
        const name = path.basename(filePath);
        const stat = await fs.stat(filePath);
        if (stat.size > HISTORY_BLOB_MAX_FILE_BYTES) {
          input.logger.warn(
            { provider: input.provider, sessionId: input.sessionId, bytes: stat.size, name },
            "Provider transcript exceeds size cap; omitting bytes from bundle",
          );
          return { name, base64: "", omitted: true };
        }
        const bytes = await fs.readFile(filePath);
        return { name, base64: bytes.toString("base64") };
      }),
    );
    return {
      provider: input.provider,
      sourceCwd: input.cwd,
      sessionId: input.sessionId,
      files: contents,
    };
  } catch (error) {
    input.logger.warn(
      { err: error, provider: input.provider, sessionId: input.sessionId },
      "Failed to capture provider history; agent will migrate without history",
    );
    return null;
  }
}

export interface MaterializeProviderHistoryInput {
  blob: HistoryBlob;
  /** cwd the agent will live at on the TARGET (its imported record's cwd). */
  targetCwd: string;
  /** `os.homedir()` captured on the SOURCE at export time. */
  sourceHome: string;
  logger: Logger;
}

/**
 * Rewrite the machine-local absolute paths a captured transcript embeds so they
 * point at the TARGET instead of the source. We replace the longer, more
 * specific `sourceCwd` first, then the `sourceHome` prefix: a cwd nested under
 * the home (e.g. cwd `/Users/a/work`, home `/Users/a`) must be remapped as a
 * whole before the home prefix is touched, otherwise the home replacement would
 * only rewrite the leading segment and leave a spliced path. When source and
 * target strings are identical (same-machine) both replacements are no-ops.
 */
function rewriteTranscriptPaths(input: {
  content: string;
  sourceCwd: string;
  targetCwd: string;
  sourceHome: string;
  targetHome: string;
}): string {
  let out = input.content;
  if (input.sourceCwd && input.sourceCwd !== input.targetCwd) {
    out = out.split(input.sourceCwd).join(input.targetCwd);
  }
  if (input.sourceHome && input.sourceHome !== input.targetHome) {
    out = out.split(input.sourceHome).join(input.targetHome);
  }
  return out;
}

/**
 * Write a captured history blob back into the provider's storage on the TARGET.
 *
 * Locatable provider (Claude): computes the target project directory from
 * `targetCwd` using the SDK-verbatim encoder, rewrites the source cwd/home in
 * each transcript to the target's, and writes the `.jsonl` there so
 * `resumeSession` / `streamHistory` rehydrates. Returns `{ ok: true }` once at
 * least one transcript is on disk at the target.
 *
 * Returns `{ ok: false }` — writing nothing misleading — when:
 *   - the provider is not locatable (codex / opencode; see module header);
 *   - the TARGET cwd does not exist on disk, so the session genuinely cannot
 *     resume there;
 *   - every transcript was `omitted` at capture time (too large) so there are no
 *     bytes to write.
 * This is the deliberate, honest seam: the caller keeps the
 * MIGRATION_HISTORY_UNAVAILABLE_LABEL behavior for the `{ ok: false }` case.
 */
export async function materializeProviderHistory(
  input: MaterializeProviderHistoryInput,
): Promise<{ ok: boolean }> {
  if (!isHistoryLocatableProvider(input.blob.provider)) {
    return { ok: false };
  }

  // The session can only resume where its working directory exists. If the
  // target machine has no such directory, refuse — do not write an unresumable
  // transcript and do not report success.
  const targetCwdExists = await isDirectory(input.targetCwd);
  if (!targetCwdExists) {
    input.logger.info(
      {
        provider: input.blob.provider,
        sessionId: input.blob.sessionId,
        targetCwd: input.targetCwd,
      },
      "Skipping provider history materialization: target cwd does not exist",
    );
    return { ok: false };
  }

  const writable = input.blob.files.filter((file) => !file.omitted && file.base64.length > 0);
  if (writable.length === 0) {
    // History existed on the source but its bytes did not travel (oversized).
    input.logger.info(
      { provider: input.blob.provider, sessionId: input.blob.sessionId },
      "Provider history had no transportable transcript bytes (omitted); flagging unavailable",
    );
    return { ok: false };
  }

  const targetHome = currentSourceHome();
  try {
    const projectDir = await claudeProjectDir(input.targetCwd);
    await fs.mkdir(projectDir, { recursive: true });
    let wrote = 0;
    for (const file of writable) {
      const target = path.join(projectDir, file.name);
      // Do not clobber a transcript the target already owns.
      try {
        await fs.access(target);
        wrote += 1; // already present counts as materialized (resumable)
        continue;
      } catch {
        // not present — safe to write
      }
      // Decode the raw bytes as UTF-8 text (provider transcripts are JSONL) and
      // rewrite the embedded source paths to the target's before writing.
      const rewritten = rewriteTranscriptPaths({
        content: Buffer.from(file.base64, "base64").toString("utf8"),
        sourceCwd: input.blob.sourceCwd,
        targetCwd: input.targetCwd,
        sourceHome: input.sourceHome,
        targetHome,
      });
      await fs.writeFile(target, rewritten, "utf8");
      wrote += 1;
    }
    return { ok: wrote > 0 };
  } catch (error) {
    input.logger.warn(
      { err: error, provider: input.blob.provider, sessionId: input.blob.sessionId },
      "Failed to materialize provider history on target",
    );
    return { ok: false };
  }
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidate);
    return stat.isDirectory();
  } catch {
    return false;
  }
}
