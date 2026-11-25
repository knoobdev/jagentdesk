import { createHash, pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GSA_SRP,
  SRP_GROUP_1024,
  SrpClientSession,
  bigintToBuffer,
  bufferToBigint,
  computeA,
  computeClientS,
  computeK,
  computeM1,
  computeM2,
  computeU,
  computeVerifier,
  computeX,
  deriveGsaPassword,
  verifyM2,
  type SrpParameters,
} from "./srp.js";

function hex(text: string): bigint {
  return BigInt(`0x${text.replace(/\s+/g, "")}`);
}

// RFC 5054 Appendix B (1024-bit group, SHA-1, username in x).
const RFC5054: SrpParameters = { group: SRP_GROUP_1024, hash: "sha1", usernameInX: true };
const VECTOR = {
  I: "alice",
  P: "password123",
  s: Buffer.from("BEB25379D1A8581EB5A727673A2441EE", "hex"),
  k: hex("7556AA04 5AEF2CDD 07ABAF0F 665C3E81 8913186F"),
  x: hex("94B7555A ABE9127C C58CCF49 93DB6CF8 4D16C124"),
  v: hex(`7E273DE8 696FFC4F 4E337D05 B4B375BE B0DDE156 9E8FA00A 9886D812
         9BADA1F1 822223CA 1A605B53 0E379BA4 729FDC59 F105B478 7E5186F5
         C671085A 1447B52A 48CF1970 B4FB6F84 00BBF4CE BFBB1681 52E08AB5
         EA53D15C 1AFF87B2 B9DA6E04 E058AD51 CC72BFC9 033B564E 26480D78
         E955A5E2 9E7AB245 DB2BE315 E2099AFB`),
  a: hex("60975527 035CF2AD 1989806F 0407210B C81EDC04 E2762A56 AFD529DD DA2D4393"),
  b: hex("E487CB59 D31AC550 471E81F0 0F6928E0 1DDA08E9 74A004F4 9E61F5D1 05284D20"),
  A: hex(`61D5E490 F6F1B795 47B0704C 436F523D D0E560F0 C64115BB 72557EC4
         4352E890 3211C046 92272D8B 2D1A5358 A2CF1B6E 0BFCF99F 921530EC
         8E393561 79EAE45E 42BA92AE ACED8251 71E1E8B9 AF6D9C03 E1327F44
         BE087EF0 6530E69F 66615261 EEF54073 CA11CF58 58F0EDFD FE15EFEA
         B349EF5D 76988A36 72FAC47B 0769447B`),
  B: hex(`BD0C6151 2C692C0C B6D041FA 01BB152D 4916A1E7 7AF46AE1 05393011
         BAF38964 DC46A067 0DD125B9 5A981652 236F99D9 B681CBF8 7837EC99
         6C6DA044 53728610 D0C6DDB5 8B318885 D7D82C7F 8DEB75CE 7BD4FBAA
         37089E6F 9C6059F3 88838E7A 00030B33 1EB76840 910440B1 B27AAEAE
         EB4012B7 D7665238 A8E3FB00 4B117B58`),
  u: hex("CE38B959 3487DA98 554ED47D 70A7AE5F 462EF019"),
  S: hex(`B0DC82BA BCF30674 AE450C02 87745E79 90A3381F 63B387AA F271A10D
         233861E3 59B48220 F7C4693C 9AE12B0A 6F67809F 0876E2D0 13800D6C
         41BB59B6 D5979B5C 00A172B4 A2A5903A 0BDCAF8A 709585EB 2AFAFA8F
         3499B200 210DCC1F 10EB3394 3CD67FC8 8A2F39A4 BE5BEC4E C0A3212D
         C346D7E4 74B29EDE 8A469FFE CA686E5A`),
};

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

describe("SRP-6a against RFC 5054 Appendix B", () => {
  it("computes k, x, v, A, u and the premaster secret", () => {
    const x = computeX(RFC5054, VECTOR.s, VECTOR.I, Buffer.from(VECTOR.P));
    expect(computeK(RFC5054)).toBe(VECTOR.k);
    expect(x).toBe(VECTOR.x);
    expect(computeVerifier(RFC5054, x)).toBe(VECTOR.v);
    expect(computeA(RFC5054, VECTOR.a)).toBe(VECTOR.A);
    expect(computeU(RFC5054, VECTOR.A, VECTOR.B)).toBe(VECTOR.u);
    expect(computeClientS(RFC5054, { a: VECTOR.a, B: VECTOR.B, x, u: VECTOR.u })).toBe(VECTOR.S);
  });

  it("agrees with the server-side premaster secret (A·v^u)^b", () => {
    const { N } = RFC5054.group;
    const serverS = modPow((VECTOR.A * modPow(VECTOR.v, VECTOR.u, N)) % N, VECTOR.b, N);
    expect(serverS).toBe(VECTOR.S);
  });
});

describe("GrandSlam SRP parameters", () => {
  it("derives the s2k password as PBKDF2-SHA256 over SHA-256(password)", () => {
    const salt = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const s2k = deriveGsaPassword({ password: "pw", salt, iterations: 1000, protocol: "s2k" });
    const s2kFo = deriveGsaPassword({ password: "pw", salt, iterations: 1000, protocol: "s2k_fo" });
    const digest = createHash("sha256").update("pw").digest();
    expect(s2k).toEqual(pbkdf2Sync(digest, salt, 1000, 32, "sha256"));
    expect(s2kFo).toEqual(
      pbkdf2Sync(Buffer.from(digest.toString("hex")), salt, 1000, 32, "sha256"),
    );
    expect(s2k.length).toBe(32);
  });

  it("completes a full exchange against a verifier that leaves the username out of x", () => {
    const username = "user@example.invalid";
    const salt = Buffer.from("a1b2c3d4e5f60718293a4b5c6d7e8f90", "hex");
    const derived = deriveGsaPassword({
      password: "correct horse",
      salt,
      iterations: 20_000,
      protocol: "s2k",
    });
    const { N, g } = GSA_SRP.group;
    // Server enrolment: v = g^x with x = H(s | H(":" | P)).
    const x = computeX(GSA_SRP, salt, "ignored-by-gsa", derived);
    const v = computeVerifier(GSA_SRP, x);
    const b = 0x1234567890abcdef1234567890abcdefn;
    const k = computeK(GSA_SRP);
    const B = (k * v + modPow(g, b, N)) % N;

    const client = new SrpClientSession(GSA_SRP, username, 0xfeedfacecafebeefn);
    const proof = client.respond({ salt, B: bigintToBuffer(B), derivedPassword: derived });

    const u = computeU(GSA_SRP, client.A, B);
    const serverS = modPow((client.A * modPow(v, u, N)) % N, b, N);
    const serverK = createHash("sha256").update(bigintToBuffer(serverS)).digest();
    expect(proof.K).toEqual(serverK);
    const serverM1 = computeM1(GSA_SRP, { username, salt, A: client.A, B, K: serverK });
    expect(proof.M1).toEqual(serverM1);
    expect(verifyM2(proof.expectedM2, computeM2(GSA_SRP, client.A, serverM1, serverK))).toBe(true);
  });

  it("rejects a server B that is a multiple of N", () => {
    const client = new SrpClientSession(GSA_SRP, "u", 5n);
    expect(() =>
      client.respond({
        salt: Buffer.alloc(16),
        B: bigintToBuffer(GSA_SRP.group.N),
        derivedPassword: Buffer.alloc(32),
      }),
    ).toThrow("invalid SRP B");
    expect(bufferToBigint(Buffer.alloc(0))).toBe(0n);
  });
});
