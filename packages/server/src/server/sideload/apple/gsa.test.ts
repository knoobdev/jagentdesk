import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AnisetteResult } from "./anisette.js";
import {
  GSA_ENDPOINTS,
  GsaClient,
  GsaError,
  XCODE_APP,
  appTokenChecksum,
  encryptAppTokens,
  encryptSpd,
  gsaResponseBody,
  parseTrustedPhones,
  type TwoFactorAnswer,
  type TwoFactorRequest,
} from "./gsa.js";
import type { AppleHttpRequest, AppleHttpResponse } from "./http.js";
import { asBuffer, asDict, asString, parseXmlPlist, type PlistDict } from "../plist.js";
import {
  GSA_SRP,
  bigintToBuffer,
  bufferToBigint,
  computeK,
  computeM1,
  computeM2,
  computeU,
  computeVerifier,
  computeX,
  deriveGsaPassword,
} from "./srp.js";

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    e >>= 1n;
    b = (b * b) % modulus;
  }
  return result;
}

const ANISETTE: AnisetteResult = {
  userAgent: "akd/1.0 CFNetwork/978.0.7 Darwin/18.7.0",
  identity: { localUserId: "lu", deviceId: "dev", remoteIdentifier: null, remoteAdiPb: null },
  data: {
    "X-Apple-I-MD": "otp-value",
    "X-Apple-I-MD-M": "machine-id",
    "X-Apple-I-MD-RINFO": "17106176",
    "X-Apple-I-MD-LU": "LU",
    "X-Mme-Device-Id": "DEVICE",
    "X-Apple-I-SRL-NO": "0",
    "X-Mme-Client-Info": "<MacBookPro15,1> <Mac OS X;10.15.2;19C57> <com.apple.AuthKit/1>",
    "X-Apple-I-Client-Time": "2026-11-04T00:00:00Z",
    "X-Apple-Locale": "en_US",
    "X-Apple-I-TimeZone": "UTC",
  },
};

const APPLE_ID = "secondary@example.invalid";
const PASSWORD = "pass word 1";
const ADSID = "000123-08-aaaa";
const IDMS = "idms-token-value";
const SK = Buffer.alloc(32, 7);
const COOKIE = Buffer.from("session-cookie");

/** An in-memory GrandSlam: real SRP server math, real spd/app-token encryption. */
function createFakeGsa(options: { twoFactor: "none" | "trusted_device" | "sms" }) {
  const salt = Buffer.from("0f1e2d3c4b5a69788796a5b4c3d2e1f0", "hex");
  const iterations = 1000;
  const x = computeX(
    GSA_SRP,
    salt,
    "",
    deriveGsaPassword({ password: PASSWORD, salt, iterations, protocol: "s2k" }),
  );
  const v = computeVerifier(GSA_SRP, x);
  const b = 0x7777777777777777777777777777n;
  const { N, g } = GSA_SRP.group;
  const B = (computeK(GSA_SRP) * v + modPow(g, b, N)) % N;
  const state = {
    verified: options.twoFactor === "none",
    smsSent: [] as number[],
    trustedPushes: 0,
    requests: [] as AppleHttpRequest[],
    A: 0n,
  };

  function plistResponse(response: PlistDict, status = 200): AppleHttpResponse {
    return { status, headers: {}, body: gsaResponseBody(response) };
  }

  async function http(request: AppleHttpRequest): Promise<AppleHttpResponse> {
    state.requests.push(request);
    if (request.url === GSA_ENDPOINTS.gsa) {
      const root = parseXmlPlist(String(request.body)) as PlistDict;
      const body = asDict(root.Request)!;
      expect(asDict(root.Header)).toEqual({ Version: "1.0.1" });
      expect(asDict(body.cpd)?.["X-Apple-I-MD"]).toBe("otp-value");
      const op = asString(body.o);
      if (op === "init") {
        expect(body.ps).toEqual(["s2k", "s2k_fo"]);
        expect(body.u).toBe(APPLE_ID);
        state.A = bufferToBigint(asBuffer(body.A2k)!);
        return plistResponse({
          sp: "s2k",
          s: salt,
          B: bigintToBuffer(B),
          c: "c-1",
          i: iterations,
          Status: { ec: 0 },
        });
      }
      if (op === "complete") {
        expect(body.c).toBe("c-1");
        const u = computeU(GSA_SRP, state.A, B);
        const S = modPow((state.A * modPow(v, u, N)) % N, b, N);
        const K = createHash("sha256").update(bigintToBuffer(S)).digest();
        const M1 = computeM1(GSA_SRP, { username: APPLE_ID, salt, A: state.A, B, K });
        if (!M1.equals(asBuffer(body.M1)!)) {
          return plistResponse({
            Status: { ec: -22406, em: "Your Apple ID or password was incorrect." },
          });
        }
        const status: PlistDict = { ec: 0 };
        if (!state.verified) {
          status.au = options.twoFactor === "sms" ? "secondaryAuth" : "trustedDeviceSecondaryAuth";
        }
        return plistResponse({
          M2: computeM2(GSA_SRP, state.A, M1, K),
          np: Buffer.alloc(32),
          spd: encryptSpd(K, { adsid: ADSID, GsIdmsToken: IDMS, sk: SK, c: COOKIE }),
          Status: status,
        });
      }
      if (op === "apptokens") {
        expect(body.u).toBe(ADSID);
        expect(body.t).toBe(IDMS);
        expect(body.app).toEqual([XCODE_APP]);
        expect(asBuffer(body.c)).toEqual(COOKIE);
        expect(asBuffer(body.checksum)).toEqual(appTokenChecksum(SK, ADSID, XCODE_APP));
        const et = encryptAppTokens(SK, Buffer.alloc(16, 3), {
          t: {
            [XCODE_APP]: { token: "xcode-token", duration: 31536000, expiry: 1_900_000_000_000 },
          },
        });
        return plistResponse({ et, Status: { ec: 0 } });
      }
      throw new Error(`unexpected op ${op}`);
    }
    expect(request.headers["X-Apple-Identity-Token"]).toBe(
      Buffer.from(`${ADSID}:${IDMS}`).toString("base64"),
    );
    expect(request.headers["X-Apple-App-Info"]).toBe(XCODE_APP);
    if (request.url === GSA_ENDPOINTS.auth) {
      return {
        status: 200,
        headers: {},
        body: Buffer.from(
          JSON.stringify({
            trustedPhoneNumbers: [{ id: 2, numberWithDialCode: "+1 (•••) •••-••12" }],
          }),
        ),
      };
    }
    if (request.url === GSA_ENDPOINTS.trustedDevice) {
      state.trustedPushes += 1;
      return { status: 200, headers: {}, body: Buffer.alloc(0) };
    }
    if (request.url === GSA_ENDPOINTS.validate) {
      const ok = request.headers["security-code"] === "123456";
      if (ok) state.verified = true;
      return {
        status: 200,
        headers: {},
        body: Buffer.from(
          `<plist><dict><key>ec</key><integer>${ok ? 0 : -21669}</integer></dict></plist>`,
        ),
      };
    }
    if (request.url === GSA_ENDPOINTS.phone) {
      state.smsSent.push(JSON.parse(String(request.body)).phoneNumber.id);
      return { status: 200, headers: {}, body: Buffer.alloc(0) };
    }
    if (request.url === GSA_ENDPOINTS.phoneCode) {
      const sent = JSON.parse(String(request.body));
      const ok = sent.securityCode.code === "654321" && sent.mode === "sms";
      if (ok) state.verified = true;
      return { status: ok ? 200 : 400, headers: {}, body: Buffer.alloc(0) };
    }
    throw new Error(`unexpected url ${request.url}`);
  }

  return { http, state };
}

function scriptedPrompt(answers: TwoFactorAnswer[]) {
  const asked: TwoFactorRequest[] = [];
  return {
    asked,
    prompt: async (request: TwoFactorRequest) => {
      asked.push(request);
      const answer = answers.shift();
      if (!answer) throw new Error("no scripted answer");
      return answer;
    },
  };
}

describe("GsaClient", () => {
  it("signs in without 2FA and returns the Xcode token", async () => {
    const fake = createFakeGsa({ twoFactor: "none" });
    const client = new GsaClient({ http: fake.http, anisette: async () => ANISETTE });
    const auth = await client.login({
      appleId: APPLE_ID,
      password: PASSWORD,
      twoFactor: async () => ({ action: "cancel" }),
    });
    expect(auth).toEqual({ adsid: ADSID, token: "xcode-token", expiresAt_ms: 1_900_000_000_000 });
    expect(fake.state.requests.map((r) => r.url)).toEqual([
      GSA_ENDPOINTS.gsa,
      GSA_ENDPOINTS.gsa,
      GSA_ENDPOINTS.gsa,
    ]);
    expect(fake.state.requests[0]!.headers["X-MMe-Client-Info"]).toBe(
      ANISETTE.data["X-Mme-Client-Info"],
    );
  });

  it("reports a wrong password as invalid_credentials", async () => {
    const fake = createFakeGsa({ twoFactor: "none" });
    const client = new GsaClient({ http: fake.http, anisette: async () => ANISETTE });
    await expect(
      client.login({
        appleId: APPLE_ID,
        password: "wrong",
        twoFactor: async () => ({ action: "cancel" }),
      }),
    ).rejects.toMatchObject({ code: "invalid_credentials" });
  });

  it("relays a trusted-device code, retries a wrong one, then signs in again", async () => {
    const fake = createFakeGsa({ twoFactor: "trusted_device" });
    const client = new GsaClient({ http: fake.http, anisette: async () => ANISETTE });
    const script = scriptedPrompt([
      { action: "code", code: "000000" },
      { action: "code", code: "123456" },
    ]);
    const auth = await client.login({
      appleId: APPLE_ID,
      password: PASSWORD,
      twoFactor: script.prompt,
    });
    expect(auth.token).toBe("xcode-token");
    expect(fake.state.trustedPushes).toBe(1);
    expect(script.asked).toEqual([
      {
        method: "trusted_device",
        phoneNumbers: [{ id: 2, number: "+1 (•••) •••-••12" }],
        message: null,
      },
      {
        method: "trusted_device",
        phoneNumbers: [{ id: 2, number: "+1 (•••) •••-••12" }],
        message: "That code was not accepted. Enter the latest code.",
      },
    ]);
  });

  it("switches to SMS when asked and validates the SMS code", async () => {
    const fake = createFakeGsa({ twoFactor: "trusted_device" });
    const client = new GsaClient({ http: fake.http, anisette: async () => ANISETTE });
    const script = scriptedPrompt([
      { action: "send_sms", phoneId: 2 },
      { action: "code", code: "654321" },
    ]);
    await client.login({ appleId: APPLE_ID, password: PASSWORD, twoFactor: script.prompt });
    expect(fake.state.smsSent).toEqual([2]);
    expect(script.asked[1]!.method).toBe("sms");
  });

  it("starts with SMS for accounts without a trusted device", async () => {
    const fake = createFakeGsa({ twoFactor: "sms" });
    const client = new GsaClient({ http: fake.http, anisette: async () => ANISETTE });
    const script = scriptedPrompt([{ action: "code", code: "654321" }]);
    await client.login({ appleId: APPLE_ID, password: PASSWORD, twoFactor: script.prompt });
    expect(fake.state.smsSent).toEqual([2]);
    expect(fake.state.trustedPushes).toBe(0);
    expect(script.asked[0]!.method).toBe("sms");
  });

  it("stops with two_factor_cancelled when the user cancels", async () => {
    const fake = createFakeGsa({ twoFactor: "trusted_device" });
    const client = new GsaClient({ http: fake.http, anisette: async () => ANISETTE });
    const error = await client
      .login({
        appleId: APPLE_ID,
        password: PASSWORD,
        twoFactor: async () => ({ action: "cancel" }),
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GsaError);
    expect((error as GsaError).code).toBe("two_factor_cancelled");
  });

  it("reads masked trusted phone numbers", () => {
    expect(
      parseTrustedPhones(
        Buffer.from(
          JSON.stringify({
            phoneNumberVerification: {
              trustedPhoneNumbers: [{ id: 1, obfuscatedNumber: "••••12" }],
            },
          }),
        ),
      ),
    ).toEqual([{ id: 1, number: "••••12" }]);
    expect(parseTrustedPhones(Buffer.from("<html>"))).toEqual([]);
  });
});
