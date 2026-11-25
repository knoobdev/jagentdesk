import type { AppleHttpRequest, AppleHttpResponse } from "../apple/http.js";
import { asString, buildXmlPlist, parseXmlPlist, type PlistDict } from "../plist.js";
import { createDevelopmentProfile, createTestCa, issueFromCsr } from "./signing-fixtures.js";

/**
 * Test-only Developer Services (QH65B2): a free team with devices, certificates, App IDs and
 * team profiles signed by a fake WWDR, answering the same plist actions Xcode sends.
 */

export const FAKE_TEAM = "A1B2C3D4E5";
const PREFIX = "https://developerservices2.apple.com/services/QH65B2/";

export interface FakeDeveloperServicesState {
  calls: Array<{ action: string; body: PlistDict; headers: Record<string, string> }>;
  devices: Array<{ deviceId: string; deviceNumber: string; name: string }>;
  certs: Array<{
    certificateId: string;
    serialNumber: string;
    machineName: string;
    machineId: string;
    der: Buffer;
  }>;
  appIds: Array<{ appIdId: string; identifier: string; name: string }>;
}

export function createFakeDeveloperServices(options: {
  kind: "free" | "paid";
  profileDays: number;
}) {
  const ca = createTestCa();
  const state: FakeDeveloperServicesState = { calls: [], devices: [], certs: [], appIds: [] };
  let counter = 0;
  const next = (prefix: string) => `${prefix}${(counter += 1).toString().padStart(4, "0")}`;
  const reply = (dict: PlistDict): AppleHttpResponse => ({
    status: 200,
    headers: {},
    body: Buffer.from(buildXmlPlist({ resultCode: 0, ...dict })),
  });

  async function http(request: AppleHttpRequest): Promise<AppleHttpResponse> {
    if (!request.url.startsWith(PREFIX)) throw new Error(`unexpected url ${request.url}`);
    const action = request.url.slice(PREFIX.length).replace(/\.action\?clientId=XABBG36SBA$/, "");
    const body = parseXmlPlist(String(request.body)) as PlistDict;
    state.calls.push({ action, body, headers: request.headers });
    switch (action) {
      case "listTeams":
        return reply({
          teams: [
            {
              teamId: FAKE_TEAM,
              name: "Sideload Tester",
              type: "Individual",
              memberships: [
                {
                  name:
                    options.kind === "free"
                      ? "Xcode Free Provisioning Program"
                      : "Apple Developer Program",
                },
              ],
            },
          ],
        });
      case "ios/listDevices":
        return reply({ devices: state.devices.map((device) => ({ ...device })) });
      case "ios/addDevice": {
        const device = {
          deviceId: next("DEV"),
          deviceNumber: asString(body.deviceNumber)!,
          name: asString(body.name)!,
        };
        state.devices.push(device);
        return reply({ device });
      }
      case "ios/listAllDevelopmentCerts":
        return reply({
          certificates: state.certs.map((cert) => ({
            certificateId: cert.certificateId,
            serialNumber: cert.serialNumber,
            name: "iOS Development",
            machineName: cert.machineName,
            machineId: cert.machineId,
            certContent: cert.der,
            expirationDate: new Date(Date.now() + 365 * 24 * 3600_000),
          })),
        });
      case "ios/submitDevelopmentCSR": {
        const serial = next("5E").toLowerCase();
        const der = issueFromCsr({
          ca,
          csrPem: asString(body.csrContent)!,
          teamId: FAKE_TEAM,
          serial,
        });
        state.certs.push({
          certificateId: next("CERT"),
          serialNumber: serial.toUpperCase(),
          machineName: asString(body.machineName)!,
          machineId: asString(body.machineId)!,
          der,
        });
        return reply({
          certRequest: { certRequestId: next("REQ"), serialNum: serial.toUpperCase() },
        });
      }
      case "ios/revokeDevelopmentCert":
        state.certs = state.certs.filter((cert) => cert.serialNumber !== body.serialNumber);
        return reply({});
      case "ios/listAppIds":
        return reply({ appIds: state.appIds.map((appId) => ({ ...appId })) });
      case "ios/addAppId": {
        const appId = {
          appIdId: next("APPID"),
          identifier: asString(body.identifier)!,
          name: asString(body.name)!,
        };
        state.appIds.push(appId);
        return reply({ appId });
      }
      case "ios/downloadTeamProvisioningProfile": {
        const appId = state.appIds.find((candidate) => candidate.appIdId === body.appIdId)!;
        const cert = state.certs.at(-1)!;
        const profile = createDevelopmentProfile({
          identity: {
            teamId: FAKE_TEAM,
            privateKeyPem: ca.keyPem,
            certificatePem: ca.certPem,
            certificateDer: cert.der,
            chainPem: [],
          },
          bundleId: appId.identifier,
          deviceUdids: state.devices.map((device) => device.deviceNumber),
          expiresAt: new Date(Date.now() + options.profileDays * 24 * 3600_000),
        });
        return reply({
          provisioningProfile: {
            provisioningProfileId: next("PROF"),
            name: "team",
            encodedProfile: profile,
          },
        });
      }
      default:
        throw new Error(`unexpected action ${action}`);
    }
  }

  return { http, state };
}
