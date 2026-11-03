import forge from "node-forge";
import { createSigningKey } from "../certs.js";
import { buildXmlPlist, type PlistDict } from "../plist.js";

/**
 * Test-only stand-ins for what Apple issues: a self-signed "Apple Development"-style
 * certificate (team id in OU, like Apple's) and CMS-signed provisioning profiles shaped like
 * a free team's development profile. Real signing tools accept them, so the signing
 * pipeline runs for real without an Apple ID.
 */

export interface DevelopmentIdentity {
  teamId: string;
  privateKeyPem: string;
  certificatePem: string;
  certificateDer: Buffer;
  /** The test CA that issued the certificate (Apple's role: WWDR). */
  chainPem: string[];
}

function newKeyPair(): forge.pki.rsa.KeyPair {
  const { privateKeyPem } = createSigningKey("JAgentDesk test");
  const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
  return { privateKey, publicKey: forge.pki.setRsaPublicKey(privateKey.n, privateKey.e) };
}

function validFor(cert: forge.pki.Certificate, days: number): void {
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + days * 24 * 3600_000);
}

export function createDevelopmentIdentity(teamId: string): DevelopmentIdentity {
  const caKeys = newKeyPair();
  const ca = forge.pki.createCertificate();
  ca.publicKey = caKeys.publicKey;
  ca.serialNumber = "01";
  validFor(ca, 30);
  const caName = [
    { shortName: "CN", value: "JAgentDesk Sideload Test CA" },
    { shortName: "O", value: "Sideload Test" },
  ];
  ca.setSubject(caName);
  ca.setIssuer(caName);
  ca.setExtensions([
    { name: "basicConstraints", cA: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true },
  ]);
  ca.sign(caKeys.privateKey, forge.md.sha256.create());

  const keys = newKeyPair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "0a1b2c3d4e5f";
  validFor(cert, 30);
  cert.setSubject([
    { type: "0.9.2342.19200300.100.1.1", value: teamId },
    { shortName: "CN", value: `Apple Development: Sideload Test (${teamId})` },
    { shortName: "OU", value: teamId },
    { shortName: "O", value: "Sideload Test" },
    { shortName: "C", value: "US" },
  ]);
  cert.setIssuer(caName);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true },
    { name: "extKeyUsage", codeSigning: true },
  ]);
  cert.sign(caKeys.privateKey, forge.md.sha256.create());
  const certificateDer = Buffer.from(
    forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(),
    "binary",
  );
  return {
    teamId,
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certificatePem: forge.pki.certificateToPem(cert),
    certificateDer,
    chainPem: [forge.pki.certificateToPem(ca)],
  };
}

export function createDevelopmentProfile(input: {
  identity: DevelopmentIdentity;
  bundleId: string;
  deviceUdids: string[];
  expiresAt: Date;
}): Buffer {
  const { identity } = input;
  const entitlements: PlistDict = {
    "application-identifier": `${identity.teamId}.${input.bundleId}`,
    "com.apple.developer.team-identifier": identity.teamId,
    "get-task-allow": true,
    "keychain-access-groups": [`${identity.teamId}.*`],
  };
  const plist = buildXmlPlist({
    AppIDName: "JAD test",
    ApplicationIdentifierPrefix: [identity.teamId],
    CreationDate: new Date(),
    DeveloperCertificates: [identity.certificateDer],
    Entitlements: entitlements,
    ExpirationDate: input.expiresAt,
    Name: `JAD test ${input.bundleId}`,
    Platform: ["iOS"],
    ProvisionedDevices: input.deviceUdids,
    TeamIdentifier: [identity.teamId],
    TeamName: "Sideload Test",
    TimeToLive: 7,
    UUID: "8C1B5D2E-4F3A-4B6C-9D7E-0A1B2C3D4E5F",
    Version: 1,
  });
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(plist, "utf8");
  const cert = forge.pki.certificateFromPem(identity.certificatePem);
  p7.addCertificate(cert);
  p7.addSigner({
    key: forge.pki.privateKeyFromPem(identity.privateKeyPem),
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256!,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType!, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest! },
      { type: forge.pki.oids.signingTime!, value: new Date().toISOString() },
    ],
  });
  p7.sign();
  return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), "binary");
}
