import { createCipheriv, createDecipheriv, createHmac } from "node:crypto";
import type { AnisetteData, AnisetteResult } from "./anisette.js";
import type { AppleHttp, AppleHttpResponse } from "./http.js";
import {
  asBuffer,
  asDict,
  asNumber,
  asString,
  buildXmlPlist,
  parsePlistDict,
  type PlistDict,
} from "../plist.js";
import {
  GSA_SRP,
  SrpClientSession,
  deriveGsaPassword,
  verifyM2,
  type GsaPasswordProtocol,
} from "./srp.js";

/**
 * GrandSlam (GSA) login for an Apple ID, clean-room from the public protocol description
 * (docs/reference/sideloadly-feature-inventory.md §2.2): SRP `init` → `complete`, the
 * encrypted `spd`, 2FA by trusted device or SMS, then the Xcode app token that Developer
 * Services accept. Nothing here logs; callers never log what it returns.
 */

const GSA_URL = "https://gsa.apple.com/grandslam/GsService2";
const TRUSTED_DEVICE_URL = "https://gsa.apple.com/auth/verify/trusteddevice";
const VALIDATE_URL = "https://gsa.apple.com/grandslam/GsService2/validate";
const AUTH_URL = "https://gsa.apple.com/auth";
const PHONE_URL = "https://gsa.apple.com/auth/verify/phone/";
const PHONE_CODE_URL = "https://gsa.apple.com/auth/verify/phone/securitycode";
export const XCODE_APP = "com.apple.gs.xcode.auth";
export const XCODE_VERSION = "11.2 (11B41)";

export type GsaErrorCode =
  | "invalid_credentials"
  | "account_locked"
  | "two_factor_cancelled"
  | "two_factor_failed"
  | "protocol_error"
  | "apple_error";

export class GsaError extends Error {
  constructor(
    readonly code: GsaErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GsaError";
  }
}

export interface TrustedPhone {
  id: number;
  number: string;
}

export interface TwoFactorRequest {
  method: "trusted_device" | "sms";
  phoneNumbers: TrustedPhone[];
  /** Set when the previous code was rejected. */
  message: string | null;
}

export type TwoFactorAnswer =
  | { action: "code"; code: string }
  | { action: "send_sms"; phoneId: number }
  | { action: "cancel" };

export type TwoFactorPrompt = (request: TwoFactorRequest) => Promise<TwoFactorAnswer>;

/** What Developer Services needs; persisted (encrypted) so refresh skips the password. */
export interface XcodeAuth {
  adsid: string;
  token: string;
  expiresAt_ms: number;
}

interface SpdSession {
  adsid: string;
  idmsToken: string;
  sk: Buffer;
  c: Buffer;
}

export interface GsaDependencies {
  http: AppleHttp;
  anisette: () => Promise<AnisetteResult>;
}

function cpd(anisette: AnisetteData): PlistDict {
  return {
    bootstrap: true,
    icscrec: true,
    pbe: false,
    prkgen: true,
    svct: "iCloud",
    loc: "en_US",
    ...anisette,
  };
}

function gsaHeaders(result: AnisetteResult): Record<string, string> {
  return {
    "Content-Type": "text/x-xml-plist",
    Accept: "*/*",
    "User-Agent": result.userAgent,
    "X-MMe-Client-Info": result.data["X-Mme-Client-Info"],
  };
}

/** Headers of the 2FA endpoints: the Xcode client identity plus anisette. */
export function twoFactorHeaders(
  anisette: AnisetteData,
  session: { adsid: string; idmsToken: string },
  json: boolean,
): Record<string, string> {
  const contentType = json ? "application/json" : "text/x-xml-plist";
  return {
    ...anisette,
    "Content-Type": contentType,
    Accept: contentType,
    "Accept-Language": "en-us",
    "User-Agent": "Xcode",
    "X-Apple-App-Info": XCODE_APP,
    "X-Xcode-Version": XCODE_VERSION,
    "X-Apple-Identity-Token": Buffer.from(`${session.adsid}:${session.idmsToken}`).toString(
      "base64",
    ),
  };
}

export function buildGsaRequest(request: PlistDict): string {
  return buildXmlPlist({ Header: { Version: "1.0.1" }, Request: request });
}

function statusOf(response: PlistDict): { ec: number; em: string; au: string | null } {
  const status = asDict(response.Status);
  return {
    ec: asNumber(status?.ec) ?? 0,
    em: asString(status?.em) ?? "",
    au: asString(status?.au),
  };
}

function checkStatus(response: PlistDict): void {
  const { ec, em } = statusOf(response);
  if (ec === 0) return;
  // -22406 and -20101: wrong Apple ID or password. -20209 and -20283: locked / disabled.
  if (ec === -22406 || ec === -20101) {
    throw new GsaError("invalid_credentials", em || "Your Apple ID or password was incorrect.");
  }
  if (ec === -20209 || ec === -20283) {
    throw new GsaError("account_locked", em || "This Apple ID is locked.");
  }
  throw new GsaError("apple_error", `${em || "Apple sign-in failed"} (${ec})`);
}

function responseDict(response: AppleHttpResponse): PlistDict {
  let root: PlistDict;
  try {
    root = parsePlistDict(response.body);
  } catch {
    if (response.status === 503) {
      throw new GsaError(
        "apple_error",
        "Apple's sign-in service refused the request (HTTP 503). This usually means it did not accept this machine's anisette data: switch the account to a remote anisette server, then try again.",
      );
    }
    throw new GsaError("protocol_error", `GrandSlam returned ${response.status} without a plist`);
  }
  const inner = asDict(root.Response);
  if (!inner) throw new GsaError("protocol_error", "GrandSlam response has no Response");
  return inner;
}

/** spd: AES-256-CBC under keys HMAC-SHA256(K, "extra data key:" / "extra data iv:"). */
export function decryptSpd(K: Buffer, spd: Buffer): PlistDict {
  const key = createHmac("sha256", K).update("extra data key:").digest();
  const iv = createHmac("sha256", K).update("extra data iv:").digest().subarray(0, 16);
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  const plain = Buffer.concat([decipher.update(spd), decipher.final()]);
  return parsePlistDict(plain);
}

/** Test helper and spec of the format: the inverse of decryptSpd. */
export function encryptSpd(K: Buffer, plist: PlistDict): Buffer {
  const key = createHmac("sha256", K).update("extra data key:").digest();
  const iv = createHmac("sha256", K).update("extra data iv:").digest().subarray(0, 16);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([cipher.update(buildXmlPlist(plist), "utf8"), cipher.final()]);
}

export function appTokenChecksum(sk: Buffer, adsid: string, app: string): Buffer {
  return createHmac("sha256", sk).update("apptokens").update(adsid).update(app).digest();
}

/** `et`: 3-byte version header (also the AAD), 16-byte IV, AES-256-GCM body, 16-byte tag. */
export function decryptAppTokens(sk: Buffer, et: Buffer): PlistDict {
  if (et.length < 3 + 16 + 16) throw new GsaError("protocol_error", "App token blob is too short");
  const header = et.subarray(0, 3);
  const iv = et.subarray(3, 19);
  const tag = et.subarray(et.length - 16);
  const body = et.subarray(19, et.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", sk, iv);
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  return parsePlistDict(Buffer.concat([decipher.update(body), decipher.final()]));
}

export function encryptAppTokens(sk: Buffer, iv: Buffer, plist: PlistDict): Buffer {
  const header = Buffer.from("XYZ");
  const cipher = createCipheriv("aes-256-gcm", sk, iv);
  cipher.setAAD(header);
  const body = Buffer.concat([cipher.update(buildXmlPlist(plist), "utf8"), cipher.final()]);
  return Buffer.concat([header, iv, body, cipher.getAuthTag()]);
}

const MAX_TWO_FACTOR_ROUNDS = 3;

export class GsaClient {
  constructor(private readonly deps: GsaDependencies) {}

  /** Full sign-in; `twoFactor` is asked only when Apple wants a code. */
  async login(input: {
    appleId: string;
    password: string;
    twoFactor: TwoFactorPrompt;
  }): Promise<XcodeAuth> {
    for (let round = 0; round <= MAX_TWO_FACTOR_ROUNDS; round += 1) {
      const anisette = await this.deps.anisette();
      const { session, au } = await this.srpLogin(input.appleId, input.password, anisette);
      if (au === "trustedDeviceSecondaryAuth" || au === "secondaryAuth") {
        await this.secondFactor({
          anisette,
          session,
          startWith: au === "secondaryAuth" ? "sms" : "trusted_device",
          prompt: input.twoFactor,
        });
        continue;
      }
      if (au !== null) {
        throw new GsaError("apple_error", `Apple asked for an unsupported sign-in step (${au}).`);
      }
      return this.xcodeToken(session, anisette);
    }
    throw new GsaError("two_factor_failed", "Apple kept asking for verification.");
  }

  private async post(anisette: AnisetteResult, request: PlistDict): Promise<PlistDict> {
    const response = await this.deps.http({
      method: "POST",
      url: GSA_URL,
      headers: gsaHeaders(anisette),
      body: buildGsaRequest(request),
    });
    return responseDict(response);
  }

  private async srpLogin(
    appleId: string,
    password: string,
    anisette: AnisetteResult,
  ): Promise<{ session: SpdSession; au: string | null }> {
    const srp = new SrpClientSession(GSA_SRP, appleId);
    const init = await this.post(anisette, {
      A2k: srp.publicKey,
      cpd: cpd(anisette.data),
      o: "init",
      ps: ["s2k", "s2k_fo"],
      u: appleId,
    });
    checkStatus(init);
    const protocol = asString(init.sp);
    const salt = asBuffer(init.s);
    const B = asBuffer(init.B);
    const cookie = asString(init.c);
    const iterations = asNumber(init.i);
    if ((protocol !== "s2k" && protocol !== "s2k_fo") || !salt || !B || !cookie || !iterations) {
      throw new GsaError("protocol_error", "GrandSlam init response is incomplete");
    }
    const derived = deriveGsaPassword({
      password,
      salt,
      iterations,
      protocol: protocol satisfies GsaPasswordProtocol,
    });
    const proof = srp.respond({ salt, B, derivedPassword: derived });
    const complete = await this.post(anisette, {
      M1: proof.M1,
      c: cookie,
      cpd: cpd(anisette.data),
      o: "complete",
      u: appleId,
    });
    checkStatus(complete);
    const M2 = asBuffer(complete.M2);
    const spd = asBuffer(complete.spd);
    if (!M2 || !spd)
      throw new GsaError("protocol_error", "GrandSlam complete response is incomplete");
    if (!verifyM2(proof.expectedM2, M2)) {
      throw new GsaError("protocol_error", "GrandSlam server proof did not verify");
    }
    const decrypted = decryptSpd(proof.K, spd);
    const adsid = asString(decrypted.adsid);
    const idmsToken = asString(decrypted.GsIdmsToken);
    const sk = asBuffer(decrypted.sk);
    const c = asBuffer(decrypted.c);
    if (!adsid || !idmsToken || !sk || !c) {
      throw new GsaError("protocol_error", "GrandSlam session data is incomplete");
    }
    return { session: { adsid, idmsToken, sk, c }, au: statusOf(complete).au };
  }

  private async xcodeToken(session: SpdSession, anisette: AnisetteResult): Promise<XcodeAuth> {
    const response = await this.post(anisette, {
      app: [XCODE_APP],
      c: session.c,
      checksum: appTokenChecksum(session.sk, session.adsid, XCODE_APP),
      cpd: cpd(anisette.data),
      o: "apptokens",
      t: session.idmsToken,
      u: session.adsid,
    });
    checkStatus(response);
    const et = asBuffer(response.et);
    if (!et) throw new GsaError("protocol_error", "GrandSlam returned no app token");
    const tokens = asDict(decryptAppTokens(session.sk, et).t);
    const xcode = asDict(tokens?.[XCODE_APP]);
    const token = asString(xcode?.token);
    const expiry = asNumber(xcode?.expiry);
    if (!token || !expiry) throw new GsaError("protocol_error", "The Xcode app token is missing");
    return { adsid: session.adsid, token, expiresAt_ms: expiry };
  }

  private async trustedPhones(
    anisette: AnisetteResult,
    session: SpdSession,
  ): Promise<TrustedPhone[]> {
    const response = await this.deps.http({
      method: "GET",
      url: AUTH_URL,
      headers: twoFactorHeaders(anisette.data, session, true),
    });
    const phones = parseTrustedPhones(response.body);
    return phones.length > 0 ? phones : [{ id: 1, number: "Trusted phone number" }];
  }

  private async secondFactor(input: {
    anisette: AnisetteResult;
    session: SpdSession;
    startWith: "trusted_device" | "sms";
    prompt: TwoFactorPrompt;
  }): Promise<void> {
    const { anisette, session } = input;
    const phones = await this.trustedPhones(anisette, session);
    let method = input.startWith;
    let phoneId = phones[0]!.id;
    if (method === "trusted_device") {
      await this.deps.http({
        method: "GET",
        url: TRUSTED_DEVICE_URL,
        headers: twoFactorHeaders(anisette.data, session, false),
      });
    } else {
      await this.sendSms(anisette, session, phoneId);
    }
    let message: string | null = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const answer = await input.prompt({ method, phoneNumbers: phones, message });
      if (answer.action === "cancel") {
        throw new GsaError("two_factor_cancelled", "Verification was cancelled.");
      }
      if (answer.action === "send_sms") {
        phoneId = answer.phoneId;
        method = "sms";
        await this.sendSms(anisette, session, phoneId);
        message = null;
        continue;
      }
      if (await this.validateCode({ anisette, session, method, phoneId, code: answer.code })) {
        return;
      }
      message = "That code was not accepted. Enter the latest code.";
    }
    throw new GsaError("two_factor_failed", "Too many incorrect verification codes.");
  }

  private async sendSms(
    anisette: AnisetteResult,
    session: SpdSession,
    phoneId: number,
  ): Promise<void> {
    const response = await this.deps.http({
      method: "PUT",
      url: PHONE_URL,
      headers: twoFactorHeaders(anisette.data, session, true),
      body: JSON.stringify({ phoneNumber: { id: phoneId }, mode: "sms" }),
    });
    if (response.status >= 400) {
      throw new GsaError("two_factor_failed", `Apple could not send an SMS (${response.status}).`);
    }
  }

  private validateCode(input: {
    anisette: AnisetteResult;
    session: SpdSession;
    method: "trusted_device" | "sms";
    phoneId: number;
    code: string;
  }): Promise<boolean> {
    if (input.method === "sms") {
      return this.validateSmsCode(input.anisette, input.session, input.phoneId, input.code);
    }
    return this.validateTrustedCode(input.anisette, input.session, input.code);
  }

  private async validateTrustedCode(
    anisette: AnisetteResult,
    session: SpdSession,
    code: string,
  ): Promise<boolean> {
    const response = await this.deps.http({
      method: "GET",
      url: VALIDATE_URL,
      headers: { ...twoFactorHeaders(anisette.data, session, false), "security-code": code },
    });
    try {
      // The validate reply carries `ec` at the root or under Status, depending on the path.
      const root = parsePlistDict(response.body);
      const ec = asNumber(root.ec) ?? statusOf(root).ec;
      return ec === 0 && response.status < 400;
    } catch {
      return false;
    }
  }

  private async validateSmsCode(
    anisette: AnisetteResult,
    session: SpdSession,
    phoneId: number,
    code: string,
  ): Promise<boolean> {
    const response = await this.deps.http({
      method: "POST",
      url: PHONE_CODE_URL,
      headers: twoFactorHeaders(anisette.data, session, true),
      body: JSON.stringify({ phoneNumber: { id: phoneId }, securityCode: { code }, mode: "sms" }),
    });
    return response.status >= 200 && response.status < 300;
  }
}

function firstArray(...candidates: unknown[]): unknown[] {
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

/** `trustedPhoneNumbers` from the /auth page JSON (masked numbers only). */
export function parseTrustedPhones(body: Buffer): TrustedPhone[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return [];
  }
  const record =
    typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const direct = record.trustedPhoneNumbers;
  const nested = (record.phoneNumberVerification as Record<string, unknown> | undefined)
    ?.trustedPhoneNumbers;
  const list = firstArray(direct, nested);
  const phones: TrustedPhone[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const number = item.numberWithDialCode ?? item.obfuscatedNumber;
    if (typeof item.id === "number" && typeof number === "string") {
      phones.push({ id: item.id, number });
    }
  }
  return phones;
}

/** Helper for tests: plist bodies the way GrandSlam frames them. */
export function gsaResponseBody(response: PlistDict): Buffer {
  return Buffer.from(buildXmlPlist({ Response: response }));
}

export const GSA_ENDPOINTS = {
  gsa: GSA_URL,
  trustedDevice: TRUSTED_DEVICE_URL,
  validate: VALIDATE_URL,
  auth: AUTH_URL,
  phone: PHONE_URL,
  phoneCode: PHONE_CODE_URL,
} as const;
