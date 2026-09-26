import fs from "node:fs";
import path from "node:path";
import forge from "node-forge";
import { resolveJAgentDeskHome } from "../jagentdesk-home.js";
import { ensurePrivateDirectory } from "../private-files.js";

// The Workbench certificate authority. A MITM proxy must present a certificate the client trusts
// for each host it terminates TLS for, so we run our own root CA: generated once, cached under
// `$JAGENTDESK_HOME/workbench/`, and used to sign a leaf certificate per hostname on demand. The
// user installs the root CA into the simulator (`xcrun simctl keychain <udid> add-root-cert`) so
// the simulator's apps trust the intercepted connections. Pure JS (node-forge) — no native deps.

export interface SignedCert {
  certPem: string;
  keyPem: string;
}

const CA_SUBJECT = [
  { name: "commonName", value: "JAgentDesk Workbench CA" },
  { name: "organizationName", value: "JAgentDesk" },
  { name: "organizationalUnitName", value: "Workbench" },
];

export class WorkbenchCA {
  private readonly dir: string;
  private caCert: forge.pki.Certificate | null = null;
  private caKey: forge.pki.rsa.PrivateKey | null = null;
  private readonly leafCache = new Map<string, SignedCert>();

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.dir = path.join(resolveJAgentDeskHome(env), "workbench");
    ensurePrivateDirectory(this.dir);
  }

  private get certPath(): string {
    return path.join(this.dir, "ca.pem");
  }
  private get keyPath(): string {
    return path.join(this.dir, "ca.key");
  }

  /** Load the cached CA, or generate and persist a new one on first use. */
  ensureCA(): void {
    if (this.caCert && this.caKey) return;
    if (fs.existsSync(this.certPath) && fs.existsSync(this.keyPath)) {
      this.caCert = forge.pki.certificateFromPem(fs.readFileSync(this.certPath, "utf8"));
      this.caKey = forge.pki.privateKeyFromPem(
        fs.readFileSync(this.keyPath, "utf8"),
      ) as forge.pki.rsa.PrivateKey;
      return;
    }
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = randomSerial();
    cert.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
    cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000);
    cert.setSubject(CA_SUBJECT);
    cert.setIssuer(CA_SUBJECT);
    cert.setExtensions([
      { name: "basicConstraints", cA: true, critical: true },
      { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
      { name: "subjectKeyIdentifier" },
    ]);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    this.caCert = cert;
    this.caKey = keys.privateKey;
    fs.writeFileSync(this.certPath, forge.pki.certificateToPem(cert), { mode: 0o600 });
    fs.writeFileSync(this.keyPath, forge.pki.privateKeyToPem(keys.privateKey), { mode: 0o600 });
  }

  /** The root CA certificate in PEM, for the user to trust in the simulator / client. */
  exportPem(): string {
    this.ensureCA();
    return forge.pki.certificateToPem(this.caCert!);
  }

  /** On-disk path to the CA PEM (for `xcrun simctl keychain <udid> add-root-cert <path>`). */
  certFilePath(): string {
    this.ensureCA();
    return this.certPath;
  }

  /** A leaf certificate + key for `host`, signed by the root CA. Cached per host. */
  certForHost(host: string): SignedCert {
    const cached = this.leafCache.get(host);
    if (cached) return cached;
    this.ensureCA();
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = randomSerial();
    cert.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
    cert.validity.notAfter = new Date(Date.now() + 2 * 365 * 24 * 60 * 60 * 1000);
    cert.setSubject([{ name: "commonName", value: host }]);
    cert.setIssuer(this.caCert!.subject.attributes);
    cert.setExtensions([
      { name: "basicConstraints", cA: false },
      {
        name: "keyUsage",
        digitalSignature: true,
        keyEncipherment: true,
        critical: true,
      },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: altNamesFor(host) },
    ]);
    cert.sign(this.caKey!, forge.md.sha256.create());
    const signed: SignedCert = {
      certPem: forge.pki.certificateToPem(cert),
      keyPem: forge.pki.privateKeyToPem(keys.privateKey),
    };
    this.leafCache.set(host, signed);
    return signed;
  }
}

// altName type 2 = DNS, type 7 = IP.
function altNamesFor(host: string): Array<{ type: number; value?: string; ip?: string }> {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return [{ type: 7, ip: host }];
  }
  return [{ type: 2, value: host }];
}

function randomSerial(): string {
  // A positive hex serial; leading "00" keeps forge from reading the high bit as negative.
  const bytes = forge.random.getBytesSync(16);
  return "00" + forge.util.bytesToHex(bytes);
}
