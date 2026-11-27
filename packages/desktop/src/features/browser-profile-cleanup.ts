import { existsSync } from "node:fs";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Spec 04 §27d.4. Before v0.1.108 every browser tab had its own profile partition
// (`persist:jagentdesk-browser-<browserId>`); closing a tab then cleared that partition, and
// `session.fromPartition` created the directory even when it had never existed. A user ended up
// with 720 empty per-tab directories. Only those per-tab directories are ever pruned: the shared
// profile (`jagentdesk-browser`) and every other partition (`jagentdesk-figma-picker`, …) are not
// matched by this pattern.
const PER_TAB_PROFILE_DIRECTORY_PATTERN =
  /^jagentdesk-browser-(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|\d{13,}-[0-9a-f]+)$/i;

const COOKIE_DATABASE_PATHS = ["Cookies", path.join("Network", "Cookies")] as const;
const LOCAL_STORAGE_LEVELDB = path.join("Local Storage", "leveldb");
const INDEXED_DB = "IndexedDB";
// Chromium writes a `META:<origin>` record for every origin that stores Local Storage data; a
// fresh database holds only its `VERSION` record.
const LOCAL_STORAGE_ORIGIN_MARKER = Buffer.from("META:");

export function isPerTabBrowserProfileDirectoryName(name: string): boolean {
  return PER_TAB_PROFILE_DIRECTORY_PATTERN.test(name);
}

export function getPartitionsDirectory(userDataPath: string): string {
  return path.join(userDataPath, "Partitions");
}

/** Whether the per-tab profile of a legacy browser id exists on disk (never creates it). */
export function perTabBrowserProfileDirectoryExists(
  userDataPath: string,
  browserId: string,
): boolean {
  const name = `jagentdesk-browser-${browserId}`;
  if (!isPerTabBrowserProfileDirectoryName(name)) {
    return false;
  }
  const partitions = getPartitionsDirectory(userDataPath);
  return (
    existsSync(path.join(partitions, name)) || existsSync(path.join(partitions, name.toLowerCase()))
  );
}

export function countCookieRows(databasePath: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare("SELECT COUNT(*) AS count FROM cookies").get() as
      | { count: number | bigint }
      | undefined;
    return Number(row?.count ?? 0);
  } finally {
    database.close();
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function listDirectory(target: string): Promise<string[]> {
  try {
    return await readdir(target);
  } catch {
    return [];
  }
}

export type BrowserProfileData = "cookies" | "localStorage" | "indexedDB";

async function findCookies(
  directory: string,
  countRows: (databasePath: string) => number,
): Promise<boolean> {
  for (const relative of COOKIE_DATABASE_PATHS) {
    const databasePath = path.join(directory, relative);
    if (!existsSync(databasePath)) continue;
    try {
      if (countRows(databasePath) > 0) return true;
    } catch {
      // An unreadable cookie database might still hold a login; keep the profile.
      return true;
    }
  }
  return false;
}

async function findLocalStorage(directory: string): Promise<boolean> {
  const leveldb = path.join(directory, LOCAL_STORAGE_LEVELDB);
  for (const entry of await listDirectory(leveldb)) {
    // A table file only exists after a compaction, which needs data.
    if (entry.endsWith(".ldb") || entry.endsWith(".sst")) return true;
    if (!entry.endsWith(".log")) continue;
    const contents = await readFile(path.join(leveldb, entry)).catch(() => null);
    if (contents === null || contents.includes(LOCAL_STORAGE_ORIGIN_MARKER)) return true;
  }
  return false;
}

async function findIndexedDb(directory: string): Promise<boolean> {
  return (await listDirectory(path.join(directory, INDEXED_DB))).length > 0;
}

/** The kinds of site data a per-tab profile directory still holds. */
export async function findBrowserProfileData(
  directory: string,
  countRows: (databasePath: string) => number = countCookieRows,
): Promise<BrowserProfileData[]> {
  const found: BrowserProfileData[] = [];
  if (await findCookies(directory, countRows)) found.push("cookies");
  if (await findLocalStorage(directory)) found.push("localStorage");
  if (await findIndexedDb(directory)) found.push("indexedDB");
  return found;
}

export interface PruneBrowserProfilesResult {
  removed: string[];
  kept: Array<{ name: string; data: BrowserProfileData[] }>;
}

/**
 * Deletes per-tab profile directories that hold no cookies, Local Storage or IndexedDB data.
 * Directories with data stay and get one log line each.
 */
export async function pruneEmptyPerTabBrowserProfiles(input: {
  userDataPath: string;
  countRows?: (databasePath: string) => number;
  logKept(name: string, data: BrowserProfileData[]): void;
  logFailure(name: string, error: unknown): void;
}): Promise<PruneBrowserProfilesResult> {
  const partitions = getPartitionsDirectory(input.userDataPath);
  const result: PruneBrowserProfilesResult = { removed: [], kept: [] };
  for (const name of await listDirectory(partitions)) {
    if (!isPerTabBrowserProfileDirectoryName(name)) continue;
    const directory = path.join(partitions, name);
    if (!(await isDirectory(directory))) continue;
    const data = await findBrowserProfileData(directory, input.countRows);
    if (data.length > 0) {
      result.kept.push({ name, data });
      input.logKept(name, data);
      continue;
    }
    try {
      await rm(directory, { recursive: true, force: true });
      result.removed.push(name);
    } catch (error) {
      input.logFailure(name, error);
    }
  }
  return result;
}
