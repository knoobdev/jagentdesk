import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * SRP-6a client (RFC 2945 / RFC 5054 arithmetic), parameterised for Apple GrandSlam:
 * 2048-bit RFC 5054 group, SHA-256, `x` computed without the username, and `g` padded to
 * the length of `N` wherever RFC 5054 pads it. Clean-room from the RFCs and the public
 * protocol description in docs/reference/sideloadly-feature-inventory.md §2.2.
 */

export type SrpHash = "sha1" | "sha256";

export interface SrpGroup {
  N: bigint;
  g: bigint;
  /** Byte length of N; PAD() left-pads to this length. */
  length: number;
}

function groupFromHex(hex: string): SrpGroup {
  const clean = hex.replace(/\s+/g, "");
  return { N: BigInt(`0x${clean}`), g: 2n, length: clean.length / 2 };
}

export const SRP_GROUP_1024 = groupFromHex(`
  EEAF0AB9 ADB38DD6 9C33F80A FA8FC5E8 60726187 75FF3C0B 9EA2314C
  9C256576 D674DF74 96EA81D3 383B4813 D692C6E0 E0D5D8E2 50B98BE4
  8E495C1D 6089DAD1 5DC7D7B4 6154D6B6 CE8EF4AD 69B15D49 82559B29
  7BCF1885 C529F566 660E57EC 68EDBC3C 05726CC0 2FD4CBF4 976EAA9A
  FD5138FE 8376435B 9FC61D2F C0EB06E3`);

export const SRP_GROUP_2048 = groupFromHex(`
  AC6BDB41 324A9A9B F166DE5E 1389582F AF72B665 1987EE07 FC319294
  3DB56050 A37329CB B4A099ED 8193E075 7767A13D D52312AB 4B03310D
  CD7F48A9 DA04FD50 E8083969 EDB767B0 CF609517 9A163AB3 661A05FB
  D5FAAAE8 2918A996 2F0B93B8 55F97993 EC975EEA A80D740A DBF4FF74
  7359D041 D5C33EA7 1D281E44 6B14773B CA97B43A 23FB8016 76BD207A
  436C6481 F1D2B907 8717461A 5B9D32E6 88F87748 544523B5 24B0D57D
  5EA77A27 75D2ECFA 032CFBDB F52FB378 61602790 04E57AE6 AF874E73
  03CE5329 9CCC041C 7BC308D8 2A5698F3 A8D0C382 71AE35F8 E9DBFBB6
  94B5C803 D89F7AE4 35DE236D 525F5475 9B65E372 FCD68EF2 0FA7111F
  9E4AFF73`);

export interface SrpParameters {
  group: SrpGroup;
  hash: SrpHash;
  /** RFC 5054 x = H(s | H(I ":" P)); GrandSlam leaves I out: H(s | H(":" P)). */
  usernameInX: boolean;
}

export const GSA_SRP: SrpParameters = { group: SRP_GROUP_2048, hash: "sha256", usernameInX: false };

export function bigintToBuffer(value: bigint): Buffer {
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  return Buffer.from(hex, "hex");
}

export function bufferToBigint(buffer: Buffer): bigint {
  return buffer.length === 0 ? 0n : BigInt(`0x${buffer.toString("hex")}`);
}

function pad(value: bigint, length: number): Buffer {
  const raw = bigintToBuffer(value);
  if (raw.length >= length) return raw;
  return Buffer.concat([Buffer.alloc(length - raw.length), raw]);
}

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

function hash(algorithm: SrpHash, ...parts: Buffer[]): Buffer {
  const h = createHash(algorithm);
  for (const part of parts) h.update(part);
  return h.digest();
}

/** k = H(N | PAD(g)) */
export function computeK(params: SrpParameters): bigint {
  const { group } = params;
  return bufferToBigint(hash(params.hash, bigintToBuffer(group.N), pad(group.g, group.length)));
}

/** x = H(s | H(I ":" P)), with I empty when `usernameInX` is false. */
export function computeX(
  params: SrpParameters,
  salt: Buffer,
  username: string,
  password: Buffer,
): bigint {
  const identity = params.usernameInX ? Buffer.from(username, "utf8") : Buffer.alloc(0);
  const inner = hash(params.hash, identity, Buffer.from(":"), password);
  return bufferToBigint(hash(params.hash, salt, inner));
}

/** u = H(PAD(A) | PAD(B)) */
export function computeU(params: SrpParameters, A: bigint, B: bigint): bigint {
  const { length } = params.group;
  return bufferToBigint(hash(params.hash, pad(A, length), pad(B, length)));
}

export function computeVerifier(params: SrpParameters, x: bigint): bigint {
  return modPow(params.group.g, x, params.group.N);
}

export function computeA(params: SrpParameters, a: bigint): bigint {
  return modPow(params.group.g, a, params.group.N);
}

/** Client premaster secret S = (B - k·g^x)^(a + u·x) mod N. */
export function computeClientS(
  params: SrpParameters,
  input: { a: bigint; B: bigint; x: bigint; u: bigint },
): bigint {
  const { N, g } = params.group;
  const k = computeK(params);
  const base = (((input.B - k * modPow(g, input.x, N)) % N) + N) % N;
  return modPow(base, input.a + input.u * input.x, N);
}

/** M1 = H(H(N) xor H(PAD(g)) | H(I) | s | A | B | K) */
export function computeM1(
  params: SrpParameters,
  input: { username: string; salt: Buffer; A: bigint; B: bigint; K: Buffer },
): Buffer {
  const { group } = params;
  const hN = hash(params.hash, bigintToBuffer(group.N));
  const hg = hash(params.hash, pad(group.g, group.length));
  const xor = Buffer.alloc(hN.length);
  for (let index = 0; index < hN.length; index += 1) xor[index] = hN[index]! ^ hg[index]!;
  return hash(
    params.hash,
    xor,
    hash(params.hash, Buffer.from(input.username, "utf8")),
    input.salt,
    bigintToBuffer(input.A),
    bigintToBuffer(input.B),
    input.K,
  );
}

/** M2 = H(A | M1 | K) */
export function computeM2(params: SrpParameters, A: bigint, M1: Buffer, K: Buffer): Buffer {
  return hash(params.hash, bigintToBuffer(A), M1, K);
}

export class SrpProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SrpProtocolError";
  }
}

export interface SrpSessionProof {
  M1: Buffer;
  /** Session key K = H(S); decrypts GrandSlam `spd`. */
  K: Buffer;
  expectedM2: Buffer;
}

/** One SRP login: A goes out on `init`, the proof on `complete`. */
export class SrpClientSession {
  readonly A: bigint;
  private readonly a: bigint;

  constructor(
    private readonly params: SrpParameters,
    private readonly username: string,
    a?: bigint,
  ) {
    this.a = a ?? bufferToBigint(randomBytes(32));
    this.A = computeA(params, this.a);
  }

  get publicKey(): Buffer {
    return bigintToBuffer(this.A);
  }

  /** `derivedPassword` is the password after any KDF (GrandSlam: PBKDF2, see below). */
  respond(input: { salt: Buffer; B: Buffer; derivedPassword: Buffer }): SrpSessionProof {
    const { N } = this.params.group;
    const B = bufferToBigint(input.B);
    if (B % N === 0n) throw new SrpProtocolError("Server sent an invalid SRP B value");
    const u = computeU(this.params, this.A, B);
    if (u === 0n) throw new SrpProtocolError("SRP u is zero");
    const x = computeX(this.params, input.salt, this.username, input.derivedPassword);
    const S = computeClientS(this.params, { a: this.a, B, x, u });
    const K = hash(this.params.hash, bigintToBuffer(S));
    const M1 = computeM1(this.params, {
      username: this.username,
      salt: input.salt,
      A: this.A,
      B,
      K,
    });
    return { M1, K, expectedM2: computeM2(this.params, this.A, M1, K) };
  }
}

export function verifyM2(expected: Buffer, actual: Buffer): boolean {
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export type GsaPasswordProtocol = "s2k" | "s2k_fo";

/**
 * GrandSlam password derivation: SHA-256 of the password (hex text of it for `s2k_fo`),
 * then PBKDF2-HMAC-SHA256 with the server's salt and iteration count, 32 bytes.
 */
export function deriveGsaPassword(input: {
  password: string;
  salt: Buffer;
  iterations: number;
  protocol: GsaPasswordProtocol;
}): Buffer {
  const digest = createHash("sha256").update(input.password, "utf8").digest();
  const material =
    input.protocol === "s2k_fo" ? Buffer.from(digest.toString("hex"), "utf8") : digest;
  return pbkdf2Sync(material, input.salt, input.iterations, 32, "sha256");
}
