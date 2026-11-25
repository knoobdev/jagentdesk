import { describe, expect, it } from "vitest";
import {
  GSA_ENDPOINTS,
  GsaClient,
  GsaError,
  parseTrustedPhones,
  type TwoFactorAnswer,
  type TwoFactorRequest,
} from "./gsa.js";
import { ADSID, ANISETTE, APPLE_ID, PASSWORD, createFakeGsa } from "../test-support/fake-gsa.js";

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
