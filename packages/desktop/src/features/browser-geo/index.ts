import { promises as fs } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import tzlookup from "@photostructure/tz-lookup";
import { Reader, type CityResponse } from "mmdb-lib";
import log from "electron-log";
import type { BrowserFingerprintProfile } from "@jagentdesk/protocol/browser-automation/fingerprint-profile";
import { COUNTRY_LANGUAGE } from "./country-language.js";

/**
 * Timezone, locale and languages from the location of a profile's exit IP.
 *
 * The exit IP is asked through the agentic-browser session, so it goes through the profile's
 * proxy. The IP is then located against DB-IP City Lite on this machine (CC BY 4.0,
 * "IP Geolocation by DB-IP"), so no third party learns the IP. The database is downloaded
 * once a month (~60 MB compressed).
 */

export interface IpGeo {
  country: string;
  timezone: string;
}

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

const EXIT_IP_URL = "https://api.ipify.org?format=json";
const LOOKUP_TIMEOUT_MS = 6_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** DB-IP publishes `dbip-city-lite-YYYY-MM.mmdb.gz` early each month; fall back a month. */
export function databaseMonths(nowMs: number): string[] {
  const now = new Date(nowMs);
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return [monthKey(now), monthKey(previous)];
}

export function languageForCountry(country: string): string {
  return COUNTRY_LANGUAGE[country] ?? "en";
}

/** The profile as a browser located at `geo` would present it. */
export function applyIpGeo(
  profile: BrowserFingerprintProfile,
  geo: IpGeo,
): BrowserFingerprintProfile {
  const language = languageForCountry(geo.country);
  const locale = `${language}-${geo.country}`;
  const languages = language === "en" ? [locale, "en"] : [locale, language, "en-US", "en"];
  const acceptLanguage = languages
    .map((lang, index) => (index === 0 ? lang : `${lang};q=${(1 - index * 0.1).toFixed(1)}`))
    .join(",");
  return { ...profile, timezone: geo.timezone, locale, languages, acceptLanguage };
}

export class IpGeoResolver {
  private reader: Reader<CityResponse> | null = null;
  private readerMonth: string | null = null;
  private loading: Promise<Reader<CityResponse> | null> | null = null;
  private readonly byIp = new Map<string, IpGeo>();

  constructor(
    private readonly options: {
      dataDir: string;
      /** Direct download of the database (not through a profile proxy). */
      download: Fetch;
      now?: () => number;
    },
  ) {}

  /** Locate the exit IP seen through `fetchThroughProfile`; null when it cannot be done. */
  async resolve(fetchThroughProfile: Fetch): Promise<IpGeo | null> {
    let ip: string;
    try {
      const response = await fetchThroughProfile(EXIT_IP_URL, {
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      });
      const body = (await response.json()) as { ip?: unknown };
      if (typeof body.ip !== "string" || body.ip.length === 0) return null;
      ip = body.ip;
    } catch (error) {
      log.warn("[browser-geo] exit IP lookup failed", { error: String(error) });
      return null;
    }
    const cached = this.byIp.get(ip);
    if (cached) return cached;
    const reader = await this.loadReader();
    if (!reader) return null;
    const record = reader.get(ip);
    const country = record?.country?.iso_code;
    const latitude = record?.location?.latitude;
    const longitude = record?.location?.longitude;
    if (!country || typeof latitude !== "number" || typeof longitude !== "number") return null;
    const geo: IpGeo = {
      country,
      timezone: record.location?.time_zone ?? tzlookup(latitude, longitude),
    };
    this.byIp.set(ip, geo);
    return geo;
  }

  private async loadReader(): Promise<Reader<CityResponse> | null> {
    const months = databaseMonths(this.options.now?.() ?? Date.now());
    if (this.reader && this.readerMonth && months.includes(this.readerMonth)) return this.reader;
    this.loading ??= this.openDatabase(months).finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async openDatabase(months: string[]): Promise<Reader<CityResponse> | null> {
    await fs.mkdir(this.options.dataDir, { recursive: true });
    for (const month of months) {
      const file = path.join(this.options.dataDir, `dbip-city-lite-${month}.mmdb`);
      const buffer =
        (await fs.readFile(file).catch(() => null)) ?? (await this.download(month, file));
      if (buffer) {
        this.reader = new Reader<CityResponse>(buffer);
        this.readerMonth = month;
        await this.removeOtherMonths(month);
        return this.reader;
      }
    }
    return null;
  }

  private async download(month: string, file: string): Promise<Buffer | null> {
    const url = `https://download.db-ip.com/free/dbip-city-lite-${month}.mmdb.gz`;
    try {
      const response = await this.options.download(url, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const buffer = gunzipSync(Buffer.from(await response.arrayBuffer()));
      const partial = `${file}.partial`;
      await fs.writeFile(partial, buffer);
      await fs.rename(partial, file);
      log.info("[browser-geo] downloaded DB-IP City Lite", { month, bytes: buffer.length });
      return buffer;
    } catch (error) {
      log.warn("[browser-geo] database download failed", { month, error: String(error) });
      return null;
    }
  }

  private async removeOtherMonths(keep: string): Promise<void> {
    const entries = await fs.readdir(this.options.dataDir).catch(() => [] as string[]);
    await Promise.all(
      entries
        .filter((name) => name.startsWith("dbip-city-lite-") && !name.includes(keep))
        .map((name) => fs.rm(path.join(this.options.dataDir, name), { force: true })),
    );
  }
}
