import { createHmac } from "node:crypto";
import { expect, it } from "vitest";
import { verifySlackSignature } from "./slack.js";
const timestamp = 1_800_000_000;
const body = Buffer.from('{ "event": "hello 👋" }');
function signed(value: Buffer = body, time = timestamp) {
  return {
    "x-slack-request-timestamp": String(time),
    "x-slack-signature": `v0=${createHmac("sha256", "signing-secret").update(`v0:${time}:`).update(value).digest("hex")}`,
  };
}
it("verifies the original bytes and rejects modified bodies and signatures", () => {
  expect(verifySlackSignature("signing-secret", body, signed(), timestamp * 1000)).toBe(true);
  expect(
    verifySlackSignature(
      "signing-secret",
      Buffer.from('{"event":"hello 👋"}'),
      signed(),
      timestamp * 1000,
    ),
  ).toBe(false);
  expect(verifySlackSignature("wrong-secret", body, signed(), timestamp * 1000)).toBe(false);
  expect(
    verifySlackSignature(
      "signing-secret",
      body,
      { ...signed(), "x-slack-signature": "v0=abcd" },
      timestamp * 1000,
    ),
  ).toBe(false);
});
it("allows 300 seconds of skew in either direction and rejects 301", () => {
  expect(verifySlackSignature("signing-secret", body, signed(), (timestamp + 300) * 1000)).toBe(
    true,
  );
  expect(verifySlackSignature("signing-secret", body, signed(), (timestamp - 300) * 1000)).toBe(
    true,
  );
  expect(verifySlackSignature("signing-secret", body, signed(), (timestamp + 301) * 1000)).toBe(
    false,
  );
  expect(verifySlackSignature("signing-secret", body, signed(), (timestamp - 301) * 1000)).toBe(
    false,
  );
  expect(
    verifySlackSignature(
      "signing-secret",
      body,
      { ...signed(), "x-slack-request-timestamp": "NaN" },
      timestamp * 1000,
    ),
  ).toBe(false);
});
