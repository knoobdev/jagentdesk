import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { generateFingerprintProfile } from "@jagentdesk/protocol/browser-automation/fingerprint-profile";

vi.mock("electron-log", () => ({ default: { info: vi.fn(), warn: vi.fn() } }));

const { applyIpGeo, databaseMonths, IpGeoResolver, languageForCountry } =
  await import("./index.js");

const profile = generateFingerprintProfile({ id: "bfp_a1b2c3", os: "windows", nowMs: 1 });

describe("IP geolocation for fingerprint profiles", () => {
  it("presents the exit IP's timezone, locale and languages", () => {
    const located = applyIpGeo(profile, { country: "VN", timezone: "Asia/Ho_Chi_Minh" });
    expect(located).toMatchObject({
      timezone: "Asia/Ho_Chi_Minh",
      locale: "vi-VN",
      languages: ["vi-VN", "vi", "en-US", "en"],
      acceptLanguage: "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
    });
    expect(located.userAgent).toBe(profile.userAgent);
  });

  it("keeps English countries short and defaults unknown countries to English", () => {
    expect(applyIpGeo(profile, { country: "US", timezone: "America/Chicago" })).toMatchObject({
      locale: "en-US",
      languages: ["en-US", "en"],
      acceptLanguage: "en-US,en;q=0.9",
    });
    expect(languageForCountry("IN")).toBe("en");
    expect(languageForCountry("ZZ")).toBe("en");
  });

  it("looks for this month's database, then last month's", () => {
    expect(databaseMonths(Date.UTC(2026, 0, 3))).toEqual(["2026-01", "2025-12"]);
  });

  it("gives up without a database download when the exit IP cannot be read", async () => {
    const download = vi.fn();
    const resolver = new IpGeoResolver({
      dataDir: mkdtempSync(path.join(tmpdir(), "geo-")),
      download,
    });
    await expect(
      resolver.resolve(async () => Promise.reject(new Error("proxy down"))),
    ).resolves.toBeNull();
    expect(download).not.toHaveBeenCalled();
  });

  it("stays unlocated when no database can be downloaded", async () => {
    const resolver = new IpGeoResolver({
      dataDir: mkdtempSync(path.join(tmpdir(), "geo-")),
      download: async () => new Response("missing", { status: 404 }),
      now: () => Date.UTC(2026, 9, 1),
    });
    const exitIp = async () => Response.json({ ip: "203.0.113.7" });
    await expect(resolver.resolve(exitIp)).resolves.toBeNull();
  });
});
