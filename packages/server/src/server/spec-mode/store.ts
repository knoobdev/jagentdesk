import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  SpecModeOptionalPhaseSchema,
  SpecModeStateSchema,
  type SpecModeOptionalPhase,
} from "@jagentdesk/protocol/spec-mode";
import { writeFileAtomic } from "../atomic-file.js";

/**
 * Spec mode state per agent (`$JAGENTDESK_HOME/spec-mode/<agentId>.json`, spec 28.5) plus what
 * the daemon needs to judge the running phase: the feature request, the agent's checkout and
 * the artefact hashes taken when the phase was sent. Optional phases are remembered per
 * workspace in `workspaces.json`.
 */
export const SpecModeRecordSchema = z.object({
  state: SpecModeStateSchema,
  cwd: z.string(),
  /** The feature description from the user's first Spec mode message. */
  request: z.string().nullable(),
  /** Artefact hashes when the current phase was sent (see phases.snapshotArtefacts). */
  before: z.record(z.string(), z.string()),
  /** The feature directory the `before` snapshot covered; null = all of `specs/`. */
  beforeScope: z.string().nullable(),
});
export type SpecModeRecord = z.infer<typeof SpecModeRecordSchema>;

const WorkspacePrefsSchema = z.record(
  z.string(),
  z.object({ optionalPhases: z.array(SpecModeOptionalPhaseSchema) }),
);

async function readJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export class SpecModeStore {
  constructor(private readonly dir: string) {}

  private recordPath(agentId: string): string {
    return path.join(this.dir, `${encodeURIComponent(agentId)}.json`);
  }

  async get(agentId: string): Promise<SpecModeRecord | null> {
    const value = await readJson(this.recordPath(agentId));
    return value === null ? null : SpecModeRecordSchema.parse(value);
  }

  async put(record: SpecModeRecord): Promise<SpecModeRecord> {
    const parsed = SpecModeRecordSchema.parse(record);
    await writeFileAtomic(
      this.recordPath(parsed.state.agentId),
      `${JSON.stringify(parsed, null, 2)}\n`,
    );
    return parsed;
  }

  async list(): Promise<SpecModeRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const records = await Promise.all(
      names
        .filter((name) => name.endsWith(".json") && name !== "workspaces.json")
        .map(async (name) => SpecModeRecordSchema.parse(await readJson(path.join(this.dir, name)))),
    );
    return records;
  }

  async getWorkspaceOptionalPhases(cwd: string): Promise<SpecModeOptionalPhase[] | null> {
    const value = await readJson(path.join(this.dir, "workspaces.json"));
    if (value === null) return null;
    return WorkspacePrefsSchema.parse(value)[cwd]?.optionalPhases ?? null;
  }

  async setWorkspaceOptionalPhases(
    cwd: string,
    optionalPhases: SpecModeOptionalPhase[],
  ): Promise<void> {
    const file = path.join(this.dir, "workspaces.json");
    const value = await readJson(file);
    const prefs = value === null ? {} : WorkspacePrefsSchema.parse(value);
    prefs[cwd] = { optionalPhases };
    await writeFileAtomic(file, `${JSON.stringify(prefs, null, 2)}\n`);
  }
}
