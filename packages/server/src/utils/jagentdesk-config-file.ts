import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  JAgentDeskConfigRawSchema,
  type JAgentDeskConfigRaw,
  type JAgentDeskConfigRevision,
  type ProjectConfigRpcError,
} from "@jagentdesk/protocol/jagentdesk-config-schema";
export {
  JAgentDeskConfigRevisionSchema,
  ProjectConfigRpcErrorSchema,
  type JAgentDeskConfigRevision,
  type ProjectConfigRpcError,
} from "@jagentdesk/protocol/jagentdesk-config-schema";
export const JAGENTDESK_CONFIG_FILE_NAME = "jagentdesk.json";
// COMPAT(predecessorProjectConfig): retained for one-way reads of projects created by
// the predecessor. New writes always use `jagentdesk.json`; remove after the project
// configuration floor is >= 0.3.0.
const LEGACY_PROJECT_CONFIG_FILE_NAME = "jagentdesk.json";

export type ReadJAgentDeskConfigForEditResult =
  | { ok: true; config: JAgentDeskConfigRaw | null; revision: JAgentDeskConfigRevision | null }
  | { ok: false; error: ProjectConfigRpcError };

export type WriteJAgentDeskConfigForEditResult =
  | { ok: true; config: JAgentDeskConfigRaw; revision: JAgentDeskConfigRevision }
  | { ok: false; error: ProjectConfigRpcError };

export interface WriteJAgentDeskConfigForEditInput {
  repoRoot: string;
  config: JAgentDeskConfigRaw;
  expectedRevision: JAgentDeskConfigRevision | null;
}

export function resolveJAgentDeskConfigPath(repoRoot: string): string {
  return join(repoRoot, JAGENTDESK_CONFIG_FILE_NAME);
}

function resolveLegacyProjectConfigPath(repoRoot: string): string {
  return join(repoRoot, LEGACY_PROJECT_CONFIG_FILE_NAME);
}

function resolveExistingConfigPath(repoRoot: string): string | null {
  const canonicalPath = resolveJAgentDeskConfigPath(repoRoot);
  if (existsSync(canonicalPath)) return canonicalPath;
  const legacyPath = resolveLegacyProjectConfigPath(repoRoot);
  return existsSync(legacyPath) ? legacyPath : null;
}

export function statJAgentDeskConfigPath(repoRoot: string): JAgentDeskConfigRevision | null {
  const configPath = resolveExistingConfigPath(repoRoot);
  if (!configPath) {
    return null;
  }
  const stats = statSync(configPath);
  return {
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  };
}

export function readJAgentDeskConfigJson(repoRoot: string): unknown {
  const configPath = resolveExistingConfigPath(repoRoot);
  if (!configPath) {
    return null;
  }
  return JSON.parse(readFileSync(configPath, "utf8"));
}

export function readJAgentDeskConfigForEdit(repoRoot: string): ReadJAgentDeskConfigForEditResult {
  try {
    const json = readJAgentDeskConfigJson(repoRoot);
    if (json === null) {
      return { ok: true, config: null, revision: null };
    }
    return {
      ok: true,
      config: JAgentDeskConfigRawSchema.parse(json),
      revision: statJAgentDeskConfigPath(repoRoot),
    };
  } catch {
    return {
      ok: false,
      error: { code: "invalid_project_config" },
    };
  }
}

export function writeJAgentDeskConfigForEdit(
  input: WriteJAgentDeskConfigForEditInput,
): WriteJAgentDeskConfigForEditResult {
  const parsed = JAgentDeskConfigRawSchema.safeParse(input.config);
  if (!parsed.success) {
    return { ok: false, error: { code: "invalid_project_config" } };
  }

  const configPath = resolveJAgentDeskConfigPath(input.repoRoot);
  const tempPath = join(
    input.repoRoot,
    `.${JAGENTDESK_CONFIG_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    writeFileSync(tempPath, `${JSON.stringify(parsed.data, null, 2)}\n`);
    const currentRevision = statJAgentDeskConfigPath(input.repoRoot);
    if (!jagentdeskConfigRevisionsEqual(currentRevision, input.expectedRevision)) {
      removeTempJAgentDeskConfig(tempPath);
      return {
        ok: false,
        error: { code: "stale_project_config", currentRevision },
      };
    }

    renameSync(tempPath, configPath);
    const revision = statJAgentDeskConfigPath(input.repoRoot);
    if (!revision) {
      return { ok: false, error: { code: "write_failed" } };
    }
    return { ok: true, config: parsed.data, revision };
  } catch {
    removeTempJAgentDeskConfig(tempPath);
    return { ok: false, error: { code: "write_failed" } };
  }
}

function jagentdeskConfigRevisionsEqual(
  left: JAgentDeskConfigRevision | null,
  right: JAgentDeskConfigRevision | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.mtimeMs === right.mtimeMs && left.size === right.size;
}

function removeTempJAgentDeskConfig(tempPath: string): void {
  try {
    rmSync(tempPath, { force: true });
  } catch {
    // Best-effort cleanup only; callers need the original write outcome.
  }
}
