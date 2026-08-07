import { randomInt, timingSafeEqual } from "node:crypto";

export interface PairingCodeDetails {
  code: string;
  expiresAtMs: number;
}

export interface PairingCodeManager {
  issue(): string;
  /** Issue a fresh code for one pending device connection. */
  issueWithExpiry(): PairingCodeDetails;
  current(): string;
  currentWithExpiry(): PairingCodeDetails;
  rotate(): PairingCodeDetails;
  verify(code: string): boolean;
  /** Verify a code against the connection that received it. */
  verifyForRequest(code: string, expected: PairingCodeDetails): boolean;
}

const CODE_TTL_MS = 5 * 60 * 1000;

export function createPairingCodeManager(now: () => number = Date.now): PairingCodeManager {
  let code = "";
  let expiresAt = 0;
  const issuedCodes = new Map<string, number>();

  const removeExpiredCodes = (): void => {
    const timestamp = now();
    for (const [issuedCode, issuedExpiresAt] of issuedCodes) {
      if (issuedExpiresAt <= timestamp) {
        issuedCodes.delete(issuedCode);
      }
    }
  };

  const createUniqueCode = (): string => {
    removeExpiredCodes();
    let nextCode = "";
    do {
      nextCode = randomInt(100000, 1000000).toString();
    } while (nextCode === code || issuedCodes.has(nextCode));
    return nextCode;
  };

  const rotate = (): PairingCodeDetails => {
    const previousCode = code;
    code = createUniqueCode();
    expiresAt = now() + CODE_TTL_MS;
    if (previousCode) {
      issuedCodes.delete(previousCode);
    }
    issuedCodes.set(code, expiresAt);
    return { code, expiresAtMs: expiresAt };
  };

  const issueWithExpiry = (): PairingCodeDetails => {
    const issuedCode = createUniqueCode();
    const issuedExpiresAt = now() + CODE_TTL_MS;
    issuedCodes.set(issuedCode, issuedExpiresAt);
    return { code: issuedCode, expiresAtMs: issuedExpiresAt };
  };

  const currentWithExpiry = (): PairingCodeDetails => {
    if (!code || expiresAt <= now()) return rotate();
    return { code, expiresAtMs: expiresAt };
  };

  return {
    issue(): string {
      return currentWithExpiry().code;
    },
    issueWithExpiry,
    current(): string {
      return currentWithExpiry().code;
    },
    currentWithExpiry,
    rotate,
    verify(candidate: string): boolean {
      removeExpiredCodes();
      if (!/^\d{6}$/.test(candidate)) return false;
      for (const issuedCode of issuedCodes.keys()) {
        if (
          issuedCode.length === candidate.length &&
          timingSafeEqual(Buffer.from(candidate), Buffer.from(issuedCode))
        ) {
          return true;
        }
      }
      return false;
    },
    verifyForRequest(candidate: string, expected: PairingCodeDetails): boolean {
      if (
        !/^\d{6}$/.test(candidate) ||
        !/^\d{6}$/.test(expected.code) ||
        expected.expiresAtMs <= now()
      ) {
        return false;
      }
      return timingSafeEqual(Buffer.from(candidate), Buffer.from(expected.code));
    },
  };
}
