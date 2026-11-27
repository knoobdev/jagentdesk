import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { THIRD_PARTY_NOTICES } from "./third-party-notices";

describe("third-party notices", () => {
  it("matches the repository file, with Orca's MIT notice", () => {
    const file = readFileSync(join(__dirname, "../../../../THIRD_PARTY_NOTICES"), "utf8");
    expect(THIRD_PARTY_NOTICES).toBe(file);
    expect(THIRD_PARTY_NOTICES).toContain("Vendor: orca");
    expect(THIRD_PARTY_NOTICES).toContain("Copyright (c) 2026 Lovecast Inc.");
  });
});
