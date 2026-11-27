// Every `bots.phone.*` key the phone surfaces read is one of Orca's phone strings (spec 37.2.1):
// a typo or a key left out of the generator's list would show the key itself on a phone.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { botsStrings } from "@/i18n/resources/bots";

const SOURCES = [
  __dirname,
  join(__dirname, "..", "items"),
  join(__dirname, "..", "settings"),
  join(__dirname, ".."),
];

function phoneKeys(): string[] {
  const keys = new Set<string>();
  for (const dir of SOURCES)
    for (const name of readdirSync(dir)) {
      if (!/\.tsx?$/.test(name) || name.endsWith(".test.ts")) continue;
      const text = readFileSync(join(dir, name), "utf8");
      for (const match of text.matchAll(/["`]bots\.phone\.([\w.]+)["`]/g))
        if (match[1]) keys.add(match[1]);
    }
  return [...keys].sort();
}

function lookup(path: string): unknown {
  let node: unknown = botsStrings.phone;
  for (const part of path.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    const record = node as Record<string, unknown>;
    node = record[part] ?? record[`${part}_other`];
  }
  return node;
}

describe("phone bots strings", () => {
  it("has an English string for every key the phone surfaces use", () => {
    const keys = phoneKeys();
    expect(keys.length).toBeGreaterThan(20);
    expect(keys.filter((key) => typeof lookup(key) !== "string")).toEqual([]);
  });

  it("keeps Orca's words with JAgentDesk for Orca", () => {
    expect(lookup("bots.soul.changeDraft")).toBe("Change your SOUL.md so that ");
    expect(lookup("bots.needs.whereItRuns")).toBe("{{need}} · open it where it runs");
    expect(JSON.stringify(botsStrings.phone)).not.toContain("Orca");
  });
});
