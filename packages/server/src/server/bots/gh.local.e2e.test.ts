import { expect, test } from "vitest";
import { countOwnOpenPullRequests, runGh } from "./triggers.js";
const authenticated = await runGh(["auth", "status"]).then(
  () => true,
  () => false,
);
// The first-run screen's "GitHub: {{count}} open PRs of yours" is the bots' only `gh` call left.
test.skipIf(!authenticated)(
  "counts the owner's open PRs with real gh when authenticated",
  async () => {
    const count = await countOwnOpenPullRequests();
    expect(count).toBeGreaterThanOrEqual(0);
  },
);
