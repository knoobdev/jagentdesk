import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { z } from "zod";

// Files under $JAGENTDESK_HOME/ssh/ are 0600 inside 0700 directories (spec 25.2).
export const SSH_DIR_MODE = 0o700;
export const SSH_FILE_MODE = 0o600;

export async function ensureSecureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: SSH_DIR_MODE });
  await fs.chmod(dir, SSH_DIR_MODE);
}

export async function writeSecureFileAtomic(filePath: string, data: string): Promise<void> {
  await ensureSecureDir(path.dirname(filePath));
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, data, { encoding: "utf8", mode: SSH_FILE_MODE });
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

export async function writeSecureJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await writeSecureFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Reads and validates a JSON file; a missing file yields `empty`. */
export async function readSecureJson<T>(
  filePath: string,
  schema: z.ZodType<T>,
  empty: T,
): Promise<T> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return empty;
    throw error;
  }
  return schema.parse(JSON.parse(raw));
}

export function newSshId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

/** Serializes async writers so read-modify-write cycles on one file never interleave. */
export class WriteQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
