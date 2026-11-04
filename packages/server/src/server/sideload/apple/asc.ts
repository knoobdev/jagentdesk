import { createPrivateKey, sign } from "node:crypto";
import forge from "node-forge";
import type { AppleHttp } from "./http.js";
import {
  TeamApiError,
  type AppleTeamApi,
  type TeamAppId,
  type TeamCert,
  type TeamDevice,
  type TeamInfo,
  type TeamProfile,
} from "./team-api.js";

/**
 * App Store Connect API (paid accounts, ADR-0032 §4): Apple's documented REST API with an
 * ES256 JWT from the user's `.p8` key. No GrandSlam, no anisette — 26.12.6 checks that an
 * install through this path never contacts gsa.apple.com.
 */

const ASC_BASE = "https://api.appstoreconnect.apple.com/v1";
const PROFILE_PREFIX = "JAD";

export interface AscKey {
  issuerId: string;
  keyId: string;
  /** PEM text of the `.p8` file. */
  privateKey: string;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** A 20-minute ES256 token (Apple's maximum). */
export function ascJwt(key: AscKey, nowMs: number): string {
  const header = base64url(JSON.stringify({ alg: "ES256", kid: key.keyId, typ: "JWT" }));
  const issuedAt = Math.floor(nowMs / 1000);
  const payload = base64url(
    JSON.stringify({
      iss: key.issuerId,
      iat: issuedAt,
      exp: issuedAt + 19 * 60,
      aud: "appstoreconnect-v1",
    }),
  );
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: createPrivateKey(key.privateKey),
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${payload}.${base64url(signature)}`;
}

interface JsonApiResource {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
}

function str(attributes: Record<string, unknown> | undefined, key: string): string | null {
  const value = attributes?.[key];
  return typeof value === "string" ? value : null;
}

function dateMs(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** OU of a certificate subject = the team id. */
export function teamIdFromCertificate(der: Buffer): string | null {
  const cert = forge.pki.certificateFromAsn1(forge.asn1.fromDer(der.toString("binary")));
  const ou = cert.subject.getField("OU");
  return typeof ou?.value === "string" ? ou.value : null;
}

export class AppStoreConnectClient implements AppleTeamApi {
  constructor(
    private readonly key: AscKey,
    private readonly http: AppleHttp,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const response = await this.http({
      method,
      url: `${ASC_BASE}${path}`,
      headers: {
        Authorization: `Bearer ${ascJwt(this.key, this.now())}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 401) {
      throw new TeamApiError("session_expired", "App Store Connect rejected the API key (401).");
    }
    const text = response.body.toString("utf8");
    if (response.status >= 400) {
      throw new TeamApiError(
        "apple_error",
        `App Store Connect ${response.status}: ${ascError(text)}`,
      );
    }
    return text ? JSON.parse(text) : null;
  }

  private async list(path: string): Promise<JsonApiResource[]> {
    const json = (await this.request("GET", path)) as { data?: JsonApiResource[] } | null;
    return json?.data ?? [];
  }

  private async create(path: string, data: unknown): Promise<JsonApiResource> {
    const json = (await this.request("POST", path, { data })) as { data?: JsonApiResource } | null;
    if (!json?.data) throw new TeamApiError("protocol_error", `App Store Connect ${path}: no data`);
    return json.data;
  }

  async listTeams(): Promise<TeamInfo[]> {
    const bundles = await this.list("/bundleIds?limit=1&fields[bundleIds]=seedId");
    const certs = await this.listCerts("");
    const seed = str(bundles[0]?.attributes, "seedId");
    const fromCert = certs.find((cert) => cert.der)?.der ?? null;
    const teamId = seed ?? (fromCert ? teamIdFromCertificate(fromCert) : null);
    return teamId ? [{ teamId, name: "App Store Connect", kind: "paid" }] : [];
  }

  async listDevices(): Promise<TeamDevice[]> {
    const devices = await this.list("/devices?limit=200&filter[platform]=IOS");
    return devices.map((device) => ({
      id: device.id,
      udid: str(device.attributes, "udid") ?? "",
      name: str(device.attributes, "name") ?? "",
    }));
  }

  async addDevice(_teamId: string, input: { udid: string; name: string }): Promise<TeamDevice> {
    const device = await this.create("/devices", {
      type: "devices",
      attributes: { name: input.name, udid: input.udid, platform: "IOS" },
    });
    return { id: device.id, udid: input.udid, name: input.name };
  }

  async listCerts(_teamId: string): Promise<TeamCert[]> {
    const certs = await this.list(
      "/certificates?limit=200&filter[certificateType]=DEVELOPMENT,IOS_DEVELOPMENT",
    );
    return certs.map((cert) => {
      const content = str(cert.attributes, "certificateContent");
      return {
        id: cert.id,
        serialNumber: str(cert.attributes, "serialNumber") ?? "",
        name: str(cert.attributes, "name") ?? str(cert.attributes, "displayName") ?? "",
        machineName: null,
        machineId: null,
        expiresAt_ms: dateMs(str(cert.attributes, "expirationDate")),
        der: content ? Buffer.from(content, "base64") : null,
      };
    });
  }

  async submitCsr(
    _teamId: string,
    input: { csrPem: string; machineName: string; machineId: string },
  ): Promise<TeamCert> {
    const csrContent = input.csrPem
      .replace(/-----(BEGIN|END) CERTIFICATE REQUEST-----/g, "")
      .replace(/\s+/g, "");
    const cert = await this.create("/certificates", {
      type: "certificates",
      attributes: { certificateType: "DEVELOPMENT", csrContent },
    });
    const content = str(cert.attributes, "certificateContent");
    if (!content)
      throw new TeamApiError("protocol_error", "App Store Connect issued no certificate");
    return {
      id: cert.id,
      serialNumber: str(cert.attributes, "serialNumber") ?? "",
      name: str(cert.attributes, "name") ?? "",
      machineName: input.machineName,
      machineId: input.machineId,
      expiresAt_ms: dateMs(str(cert.attributes, "expirationDate")),
      der: Buffer.from(content, "base64"),
    };
  }

  async revokeCert(_teamId: string, cert: TeamCert): Promise<void> {
    await this.request("DELETE", `/certificates/${encodeURIComponent(cert.id)}`);
  }

  async listAppIds(): Promise<TeamAppId[]> {
    const bundles = await this.list("/bundleIds?limit=200&filter[platform]=IOS");
    return bundles.map((bundle) => ({
      id: bundle.id,
      bundleId: str(bundle.attributes, "identifier") ?? "",
      name: str(bundle.attributes, "name") ?? "",
      expiresAt_ms: null,
    }));
  }

  async addAppId(_teamId: string, input: { bundleId: string; name: string }): Promise<TeamAppId> {
    const bundle = await this.create("/bundleIds", {
      type: "bundleIds",
      attributes: { identifier: input.bundleId, name: input.name, platform: "IOS" },
    });
    return { id: bundle.id, bundleId: input.bundleId, name: input.name, expiresAt_ms: null };
  }

  async profile(
    _teamId: string,
    input: { appId: TeamAppId; cert: TeamCert; devices: TeamDevice[] },
  ): Promise<TeamProfile> {
    const name = `${PROFILE_PREFIX} ${input.appId.bundleId}`;
    // One live JAD profile per App ID: replace the previous one so devices/cert stay current.
    const existing = await this.list(
      `/profiles?limit=200&filter[name]=${encodeURIComponent(name)}`,
    );
    for (const old of existing) {
      await this.request("DELETE", `/profiles/${encodeURIComponent(old.id)}`);
    }
    const profile = await this.create("/profiles", {
      type: "profiles",
      attributes: { name, profileType: "IOS_APP_DEVELOPMENT" },
      relationships: {
        bundleId: { data: { type: "bundleIds", id: input.appId.id } },
        certificates: { data: [{ type: "certificates", id: input.cert.id }] },
        devices: { data: input.devices.map((device) => ({ type: "devices", id: device.id })) },
      },
    });
    const content = str(profile.attributes, "profileContent");
    if (!content) throw new TeamApiError("protocol_error", "App Store Connect returned no profile");
    return { id: profile.id, data: Buffer.from(content, "base64") };
  }
}

function ascError(text: string): string {
  try {
    const json = JSON.parse(text) as { errors?: Array<{ title?: string; detail?: string }> };
    const first = json.errors?.[0];
    if (first) return [first.title, first.detail].filter(Boolean).join(" — ");
  } catch {
    return text.slice(0, 300);
  }
  return text.slice(0, 300);
}
