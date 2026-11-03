import { randomUUID } from "node:crypto";
import type { AnisetteData } from "./anisette.js";
import { XCODE_APP, XCODE_VERSION, type XcodeAuth } from "./gsa.js";
import type { AppleHttp } from "./http.js";
import {
  asArray,
  asBuffer,
  asDict,
  asNumber,
  asString,
  buildXmlPlist,
  parsePlistDict,
  type PlistDict,
  type PlistValue,
} from "../plist.js";
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
 * Xcode's Developer Services protocol (QH65B2), clean-room from the action names Xcode
 * itself exposes (docs/reference/sideloadly-feature-inventory.md §2.4). Every call is a
 * plist POST signed by the GrandSlam Xcode token plus fresh anisette headers.
 */

const BASE = "https://developerservices2.apple.com/services/QH65B2";
const CLIENT_ID = "XABBG36SBA";
const PROTOCOL_VERSION = "QH65B2";

export interface DeveloperServicesDependencies {
  http: AppleHttp;
  auth: () => Promise<XcodeAuth>;
  anisette: () => Promise<AnisetteData>;
  requestId?: () => string;
}

export function developerServicesUrl(action: string): string {
  return `${BASE}/${action}.action?clientId=${CLIENT_ID}`;
}

export function developerServicesHeaders(
  auth: XcodeAuth,
  anisette: AnisetteData,
): Record<string, string> {
  return {
    ...anisette,
    "Content-Type": "text/x-xml-plist",
    Accept: "text/x-xml-plist",
    "Accept-Language": "en-us",
    "User-Agent": "Xcode",
    "X-Apple-App-Info": XCODE_APP,
    "X-Xcode-Version": XCODE_VERSION,
    "X-Apple-I-Identity-Id": auth.adsid,
    "X-Apple-GS-Token": auth.token,
  };
}

export function developerServicesBody(params: PlistDict, requestId: string): string {
  return buildXmlPlist({
    clientId: CLIENT_ID,
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    userLocale: ["en_US"],
    ...params,
  });
}

function dateMs(value: PlistValue | undefined): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function dicts(value: PlistValue | undefined): PlistDict[] {
  const list = asArray(value) ?? [];
  const out: PlistDict[] = [];
  for (const item of list) {
    const dict = asDict(item);
    if (dict) out.push(dict);
  }
  return out;
}

function requireString(dict: PlistDict, key: string): string {
  const value = asString(dict[key]);
  if (value === null)
    throw new TeamApiError("protocol_error", `Developer Services: missing ${key}`);
  return value;
}

function toDevice(dict: PlistDict): TeamDevice {
  return {
    id: requireString(dict, "deviceId"),
    udid: requireString(dict, "deviceNumber"),
    name: asString(dict.name) ?? "",
  };
}

function toCert(dict: PlistDict): TeamCert {
  return {
    id: requireString(dict, "certificateId"),
    serialNumber: asString(dict.serialNumber) ?? asString(dict.serialNum) ?? "",
    name: asString(dict.name) ?? "",
    machineName: asString(dict.machineName),
    machineId: asString(dict.machineId),
    expiresAt_ms: dateMs(dict.expirationDate),
    der: asBuffer(dict.certContent),
  };
}

function toAppId(dict: PlistDict): TeamAppId {
  return {
    id: requireString(dict, "appIdId"),
    bundleId: requireString(dict, "identifier"),
    name: asString(dict.name) ?? "",
    expiresAt_ms: dateMs(dict.expirationDate),
  };
}

function teamKind(team: PlistDict): "free" | "paid" {
  for (const membership of dicts(team.memberships)) {
    const name = (asString(membership.name) ?? "").toLowerCase();
    if (name.includes("developer program") && !name.includes("free")) return "paid";
  }
  return "free";
}

export class DeveloperServicesClient implements AppleTeamApi {
  constructor(private readonly deps: DeveloperServicesDependencies) {}

  private async call(action: string, params: PlistDict): Promise<PlistDict> {
    const [auth, anisette] = await Promise.all([this.deps.auth(), this.deps.anisette()]);
    const requestId = this.deps.requestId?.() ?? randomUUID().toUpperCase();
    const response = await this.deps.http({
      method: "POST",
      url: developerServicesUrl(action),
      headers: developerServicesHeaders(auth, anisette),
      body: developerServicesBody(params, requestId),
    });
    if (response.status === 401 || response.status === 403) {
      throw new TeamApiError("session_expired", "The Apple developer session expired.");
    }
    let root: PlistDict;
    try {
      root = parsePlistDict(response.body);
    } catch {
      throw new TeamApiError(
        "protocol_error",
        `Developer Services ${action} returned ${response.status} without a plist`,
      );
    }
    const resultCode = asNumber(root.resultCode) ?? 0;
    if (resultCode !== 0) {
      const text = asString(root.userString) ?? asString(root.resultString) ?? "Request failed";
      // 1100: "Your session has expired. Please log in." (Xcode's own wording).
      const code = resultCode === 1100 ? "session_expired" : "apple_error";
      throw new TeamApiError(code, `${text} (${resultCode})`);
    }
    return root;
  }

  async listTeams(): Promise<TeamInfo[]> {
    const root = await this.call("listTeams", {});
    return dicts(root.teams).map((team) => ({
      teamId: requireString(team, "teamId"),
      name: asString(team.name) ?? "",
      kind: teamKind(team),
    }));
  }

  async listDevices(teamId: string): Promise<TeamDevice[]> {
    const root = await this.call("ios/listDevices", { teamId });
    return dicts(root.devices).map(toDevice);
  }

  async addDevice(teamId: string, input: { udid: string; name: string }): Promise<TeamDevice> {
    const root = await this.call("ios/addDevice", {
      teamId,
      deviceNumber: input.udid,
      name: input.name,
      DTDK_Platform: "ios",
    });
    const device = asDict(root.device);
    if (!device) throw new TeamApiError("protocol_error", "addDevice returned no device");
    return toDevice(device);
  }

  async listCerts(teamId: string): Promise<TeamCert[]> {
    const root = await this.call("ios/listAllDevelopmentCerts", { teamId });
    return dicts(root.certificates).map(toCert);
  }

  async submitCsr(
    teamId: string,
    input: { csrPem: string; machineName: string; machineId: string },
  ): Promise<TeamCert> {
    const root = await this.call("ios/submitDevelopmentCSR", {
      teamId,
      csrContent: input.csrPem,
      machineId: input.machineId,
      machineName: input.machineName,
    });
    const request = asDict(root.certRequest);
    const serial = (asString(request?.serialNum) ?? "").toLowerCase();
    const certs = await this.listCerts(teamId);
    const issued =
      certs.find((cert) => serial !== "" && cert.serialNumber.toLowerCase() === serial) ??
      certs.find((cert) => cert.machineId === input.machineId);
    if (!issued?.der) {
      throw new TeamApiError("protocol_error", "The new development certificate was not listed");
    }
    return issued;
  }

  async revokeCert(teamId: string, cert: TeamCert): Promise<void> {
    await this.call("ios/revokeDevelopmentCert", { teamId, serialNumber: cert.serialNumber });
  }

  async listAppIds(teamId: string): Promise<TeamAppId[]> {
    const root = await this.call("ios/listAppIds", { teamId });
    return dicts(root.appIds).map(toAppId);
  }

  async addAppId(teamId: string, input: { bundleId: string; name: string }): Promise<TeamAppId> {
    const root = await this.call("ios/addAppId", {
      teamId,
      identifier: input.bundleId,
      name: input.name,
    });
    const appId = asDict(root.appId);
    if (!appId) throw new TeamApiError("protocol_error", "addAppId returned no App ID");
    return toAppId(appId);
  }

  async profile(teamId: string, input: { appId: TeamAppId }): Promise<TeamProfile> {
    const root = await this.call("ios/downloadTeamProvisioningProfile", {
      teamId,
      appIdId: input.appId.id,
    });
    const profile = asDict(root.provisioningProfile);
    const data = asBuffer(profile?.encodedProfile);
    if (!profile || !data) throw new TeamApiError("protocol_error", "No provisioning profile");
    return { id: asString(profile.provisioningProfileId) ?? "", data };
  }
}
