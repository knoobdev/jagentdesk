import { describe, expect, it } from "vitest";
import { claimPairingExchange } from "./active-exchange";

describe("claimPairingExchange", () => {
  it("refuses a second exchange for the same link while the first runs", () => {
    const first = new AbortController();
    const claim = claimPairingExchange("pk-a", first);
    expect(claim).not.toBeNull();
    expect(claimPairingExchange("pk-a", new AbortController())).toBeNull();
    expect(first.signal.aborted).toBe(false);
    claim!.release();
    const again = claimPairingExchange("pk-a", new AbortController());
    expect(again).not.toBeNull();
    again!.release();
  });

  it("aborts the exchange for an older link when a newer one starts", () => {
    const older = new AbortController();
    const olderClaim = claimPairingExchange("pk-old", older);
    const newer = claimPairingExchange("pk-new", new AbortController());
    expect(older.signal.aborted).toBe(true);
    // The older screen releasing late must not free the newer claim.
    olderClaim!.release();
    expect(claimPairingExchange("pk-new", new AbortController())).toBeNull();
    newer!.release();
  });

  it("lets a link be opened again after its screen aborted", () => {
    const aborted = new AbortController();
    claimPairingExchange("pk-b", aborted);
    aborted.abort();
    const reopened = claimPairingExchange("pk-b", new AbortController());
    expect(reopened).not.toBeNull();
    reopened!.release();
  });
});
