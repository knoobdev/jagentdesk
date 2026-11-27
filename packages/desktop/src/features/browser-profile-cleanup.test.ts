import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findBrowserProfileData,
  isPerTabBrowserProfileDirectoryName,
  perTabBrowserProfileDirectoryExists,
  pruneEmptyPerTabBrowserProfiles,
} from "./browser-profile-cleanup";

const TAB_IDS = [
  "0b6f1c1e-3c2a-4f5e-9a7b-1d2e3f4a5b6c",
  "7d8e9f00-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
  "c1d2e3f4-a5b6-4c7d-9e8f-0a1b2c3d4e5f",
];
const TAB_WITH_COOKIE = "f0e1d2c3-b4a5-4968-8776-655443322110";

let userData: string;
let partitions: string;

function createCookieDatabase(directory: string, rows: Array<{ host: string; name: string }>) {
  mkdirSync(directory, { recursive: true });
  const database = new DatabaseSync(path.join(directory, "Cookies"));
  database.exec(
    "CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);" +
      "CREATE TABLE cookies(creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL, " +
      "top_frame_site_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, " +
      "encrypted_value BLOB NOT NULL, path TEXT NOT NULL, expires_utc INTEGER NOT NULL);",
  );
  const insert = database.prepare(
    "INSERT INTO cookies VALUES (13370000000000000, ?, '', ?, '', x'', '/', 0)",
  );
  for (const row of rows) insert.run(row.host, row.name);
  database.close();
}

/** What Chromium leaves in a partition it opened and cleared without ever storing site data. */
function createUnusedPartition(name: string): string {
  const directory = path.join(partitions, name);
  createCookieDatabase(path.join(directory, "Network"), []);
  const leveldb = path.join(directory, "Local Storage", "leveldb");
  mkdirSync(leveldb, { recursive: true });
  writeFileSync(path.join(leveldb, "CURRENT"), "MANIFEST-000001\n");
  writeFileSync(path.join(leveldb, "LOCK"), "");
  writeFileSync(path.join(leveldb, "000003.log"), Buffer.from("\u0000\u0000VERSION\u00011"));
  writeFileSync(path.join(directory, "Preferences"), "{}");
  return directory;
}

function partitionNames(): string[] {
  return readdirSync(partitions).sort();
}

beforeEach(() => {
  userData = mkdtempSync(path.join(tmpdir(), "jagentdesk-profile-cleanup-"));
  partitions = path.join(userData, "Partitions");
  mkdirSync(partitions);
});

afterEach(() => {
  rmSync(userData, { recursive: true, force: true });
});

describe("isPerTabBrowserProfileDirectoryName", () => {
  it("matches only per-tab profiles", () => {
    expect(isPerTabBrowserProfileDirectoryName(`jagentdesk-browser-${TAB_IDS[0]}`)).toBe(true);
    expect(isPerTabBrowserProfileDirectoryName("jagentdesk-browser-1732700000000-9f3a")).toBe(true);
    expect(isPerTabBrowserProfileDirectoryName("jagentdesk-browser")).toBe(false);
    expect(isPerTabBrowserProfileDirectoryName("jagentdesk-figma-picker")).toBe(false);
    expect(isPerTabBrowserProfileDirectoryName("jagentdesk-browser-settings")).toBe(false);
    expect(isPerTabBrowserProfileDirectoryName(`other-browser-${TAB_IDS[0]}`)).toBe(false);
  });
});

describe("findBrowserProfileData", () => {
  it("finds nothing in a partition that never stored site data", async () => {
    const directory = createUnusedPartition(`jagentdesk-browser-${TAB_IDS[0]}`);
    expect(await findBrowserProfileData(directory)).toEqual([]);
  });

  it("finds cookie rows in either cookie database location", async () => {
    const legacy = path.join(partitions, `jagentdesk-browser-${TAB_IDS[0]}`);
    createCookieDatabase(legacy, [{ host: "localhost", name: "session" }]);
    const network = createUnusedPartition(`jagentdesk-browser-${TAB_IDS[1]}`);
    rmSync(path.join(network, "Network"), { recursive: true });
    createCookieDatabase(path.join(network, "Network"), [
      { host: ".github.com", name: "logged_in" },
    ]);

    expect(await findBrowserProfileData(legacy)).toEqual(["cookies"]);
    expect(await findBrowserProfileData(network)).toEqual(["cookies"]);
  });

  it("finds Local Storage origins and IndexedDB databases", async () => {
    const localStorage = createUnusedPartition(`jagentdesk-browser-${TAB_IDS[0]}`);
    writeFileSync(
      path.join(localStorage, "Local Storage", "leveldb", "000003.log"),
      Buffer.from(
        "\u0000VERSION\u00011\u0000META:http://localhost:5173\u0000_http://localhost:5173",
      ),
    );
    const indexedDb = createUnusedPartition(`jagentdesk-browser-${TAB_IDS[1]}`);
    mkdirSync(path.join(indexedDb, "IndexedDB", "http_localhost_5173.indexeddb.leveldb"), {
      recursive: true,
    });
    const compacted = createUnusedPartition(`jagentdesk-browser-${TAB_IDS[2]}`);
    writeFileSync(path.join(compacted, "Local Storage", "leveldb", "000005.ldb"), "table");

    expect(await findBrowserProfileData(localStorage)).toEqual(["localStorage"]);
    expect(await findBrowserProfileData(indexedDb)).toEqual(["indexedDB"]);
    expect(await findBrowserProfileData(compacted)).toEqual(["localStorage"]);
  });

  it("treats an unreadable cookie database as data", async () => {
    const directory = path.join(partitions, `jagentdesk-browser-${TAB_IDS[0]}`);
    mkdirSync(directory);
    writeFileSync(path.join(directory, "Cookies"), "not a sqlite database");
    expect(await findBrowserProfileData(directory)).toEqual(["cookies"]);
  });
});

describe("pruneEmptyPerTabBrowserProfiles", () => {
  it("removes empty per-tab profiles and keeps the one with a cookie and every other partition", async () => {
    for (const id of TAB_IDS) createUnusedPartition(`jagentdesk-browser-${id}`);
    const withCookie = createUnusedPartition(`jagentdesk-browser-${TAB_WITH_COOKIE}`);
    rmSync(path.join(withCookie, "Network"), { recursive: true });
    createCookieDatabase(path.join(withCookie, "Network"), [{ host: "localhost", name: "sid" }]);
    // The shared profile and other partitions look just as empty and must stay.
    createUnusedPartition("jagentdesk-browser");
    createUnusedPartition("jagentdesk-figma-picker");
    writeFileSync(path.join(partitions, `jagentdesk-browser-${TAB_IDS[0]}.lock`), "");

    const kept: string[] = [];
    const result = await pruneEmptyPerTabBrowserProfiles({
      userDataPath: userData,
      logKept: (name, data) => kept.push(`${name}:${data.join(",")}`),
      logFailure: (name, error) => {
        throw new Error(`unexpected failure for ${name}: ${String(error)}`);
      },
    });

    expect(result.removed.sort()).toEqual(TAB_IDS.map((id) => `jagentdesk-browser-${id}`).sort());
    expect(kept).toEqual([`jagentdesk-browser-${TAB_WITH_COOKIE}:cookies`]);
    expect(partitionNames()).toEqual(
      [
        "jagentdesk-browser",
        `jagentdesk-browser-${TAB_IDS[0]}.lock`,
        `jagentdesk-browser-${TAB_WITH_COOKIE}`,
        "jagentdesk-figma-picker",
      ].sort(),
    );
  });

  it("does nothing when there is no Partitions directory", async () => {
    rmSync(partitions, { recursive: true });
    const result = await pruneEmptyPerTabBrowserProfiles({
      userDataPath: userData,
      logKept: () => {},
      logFailure: () => {},
    });
    expect(result).toEqual({ removed: [], kept: [] });
  });
});

describe("perTabBrowserProfileDirectoryExists", () => {
  it("reports only existing per-tab profiles and never creates one", () => {
    createUnusedPartition(`jagentdesk-browser-${TAB_IDS[0]}`);
    expect(perTabBrowserProfileDirectoryExists(userData, TAB_IDS[0])).toBe(true);
    expect(perTabBrowserProfileDirectoryExists(userData, TAB_IDS[1])).toBe(false);
    expect(perTabBrowserProfileDirectoryExists(userData, "../jagentdesk-browser")).toBe(false);
    expect(partitionNames()).toEqual([`jagentdesk-browser-${TAB_IDS[0]}`]);
  });
});
