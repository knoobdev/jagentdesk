/**
 * What sideload needs from an Apple team, whichever way the account signs in: the Xcode
 * Developer Services protocol (Apple ID) or the official App Store Connect API (paid
 * accounts with an API key). Apple changes these protocols; each is one adapter.
 */

export interface TeamInfo {
  teamId: string;
  name: string;
  kind: "free" | "paid";
}

export interface TeamDevice {
  id: string;
  udid: string;
  name: string;
}

export interface TeamCert {
  id: string;
  serialNumber: string;
  name: string;
  machineName: string | null;
  machineId: string | null;
  expiresAt_ms: number | null;
  /** DER certificate, when the listing carries it. */
  der: Buffer | null;
}

export interface TeamAppId {
  id: string;
  bundleId: string;
  name: string;
  expiresAt_ms: number | null;
}

export interface TeamProfile {
  id: string;
  /** The signed `.mobileprovision` bytes. */
  data: Buffer;
}

export interface AppleTeamApi {
  listTeams(): Promise<TeamInfo[]>;
  listDevices(teamId: string): Promise<TeamDevice[]>;
  addDevice(teamId: string, input: { udid: string; name: string }): Promise<TeamDevice>;
  listCerts(teamId: string): Promise<TeamCert[]>;
  /** Submits a PEM CSR; returns the issued development certificate (with its DER). */
  submitCsr(
    teamId: string,
    input: { csrPem: string; machineName: string; machineId: string },
  ): Promise<TeamCert>;
  revokeCert(teamId: string, cert: TeamCert): Promise<void>;
  listAppIds(teamId: string): Promise<TeamAppId[]>;
  addAppId(teamId: string, input: { bundleId: string; name: string }): Promise<TeamAppId>;
  /** A development profile for this App ID covering `cert` and `devices`. */
  profile(
    teamId: string,
    input: { appId: TeamAppId; cert: TeamCert; devices: TeamDevice[] },
  ): Promise<TeamProfile>;
}

export type TeamApiErrorCode = "session_expired" | "apple_error" | "protocol_error";

export class TeamApiError extends Error {
  constructor(
    readonly code: TeamApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TeamApiError";
  }
}

/** App ID names must be letters, digits and spaces. */
export function appIdName(appName: string, bundleId: string): string {
  const cleaned = appName
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const fallback = bundleId.replace(/[^A-Za-z0-9]+/g, " ").trim();
  return `JAD ${cleaned || fallback}`.slice(0, 50);
}
