import { expect, test } from "vitest";
import { runGh } from "./triggers.js";
const authenticated = await runGh(["auth", "status"]).then(
  () => true,
  () => false,
);
test.skipIf(!authenticated)("queries real gh when authenticated", async () => {
  const rows: unknown = JSON.parse(
    await runGh([
      "search",
      "prs",
      "--review-requested=@me",
      "--state=open",
      "--json=url,title,updatedAt",
      "--limit=1",
    ]),
  );
  expect(Array.isArray(rows)).toBe(true);
});
