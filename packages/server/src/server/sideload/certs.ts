import { generateKeyPairSync } from "node:crypto";
import forge from "node-forge";
import {
  asArray,
  asBuffer,
  asDict,
  asString,
  parseXmlPlist,
  type PlistDict,
  type PlistValue,
} from "./plist.js";

/**
 * Development signing identity: an RSA-2048 key + CSR the daemon generates (the key never
 * leaves the sideload secret store) and the provisioning profiles Apple issues for it.
 */

export interface SigningKey {
  privateKeyPem: string;
  csrPem: string;
}

export function createSigningKey(commonName: string): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = forge.pki.publicKeyFromPem(
    publicKey.export({ type: "spki", format: "pem" }).toString(),
  );
  csr.setSubject([
    { shortName: "C", value: "US" },
    { shortName: "ST", value: "CA" },
    { shortName: "O", value: "JAgentDesk" },
    { shortName: "CN", value: commonName },
  ]);
  csr.sign(forge.pki.privateKeyFromPem(privateKeyPem), forge.md.sha256.create());
  return { privateKeyPem, csrPem: forge.pki.certificationRequestToPem(csr) };
}

export function certificateDerToPem(der: Buffer): string {
  const body = der
    .toString("base64")
    .replace(/(.{64})/g, "$1\n")
    .trim();
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

export function certificateSerial(der: Buffer): string {
  const cert = forge.pki.certificateFromAsn1(forge.asn1.fromDer(der.toString("binary")));
  return cert.serialNumber.toUpperCase();
}

export function certificateMatchesKey(der: Buffer, privateKeyPem: string): boolean {
  const cert = forge.pki.certificateFromAsn1(forge.asn1.fromDer(der.toString("binary")));
  const key = forge.pki.privateKeyFromPem(privateKeyPem);
  const publicKey = cert.publicKey as forge.pki.rsa.PublicKey;
  return publicKey.n.equals(key.n) && publicKey.e.equals(key.e);
}

export interface ProvisioningProfile {
  name: string;
  teamId: string;
  /** `application-identifier` = `<TEAMID>.<bundle id>`. */
  applicationIdentifier: string;
  bundleId: string;
  expiresAt_ms: number;
  provisionedDevices: string[];
  entitlements: PlistDict;
  developerCertificates: Buffer[];
}

export class ProfileParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileParseError";
  }
}

/** The plist inside a CMS-signed `.mobileprovision`. */
export function profilePlist(data: Buffer): PlistDict {
  const text = data.toString("latin1");
  const start = text.indexOf("<?xml");
  const end = text.indexOf("</plist>");
  if (start === -1 || end === -1) throw new ProfileParseError("Not a provisioning profile");
  const xml = data.subarray(start, end + "</plist>".length).toString("utf8");
  const value: PlistValue = parseXmlPlist(xml);
  const dict = asDict(value);
  if (!dict) throw new ProfileParseError("Provisioning profile plist is not a dictionary");
  return dict;
}

export function parseProfile(data: Buffer): ProvisioningProfile {
  const plist = profilePlist(data);
  const entitlements = asDict(plist.Entitlements) ?? {};
  const applicationIdentifier = asString(entitlements["application-identifier"]) ?? "";
  const teamIds = asArray(plist.TeamIdentifier) ?? [];
  const teamId = asString(teamIds[0]) ?? "";
  const expiration = plist.ExpirationDate;
  if (!(expiration instanceof Date)) throw new ProfileParseError("Profile has no ExpirationDate");
  const devices = (asArray(plist.ProvisionedDevices) ?? []).flatMap((item) =>
    typeof item === "string" ? [item] : [],
  );
  const certs = (asArray(plist.DeveloperCertificates) ?? []).flatMap((item) => {
    const buffer = asBuffer(item);
    return buffer ? [buffer] : [];
  });
  return {
    name: asString(plist.Name) ?? "",
    teamId,
    applicationIdentifier,
    bundleId: applicationIdentifier.startsWith(`${teamId}.`)
      ? applicationIdentifier.slice(teamId.length + 1)
      : applicationIdentifier,
    expiresAt_ms: expiration.getTime(),
    provisionedDevices: devices,
    entitlements,
    developerCertificates: certs,
  };
}
