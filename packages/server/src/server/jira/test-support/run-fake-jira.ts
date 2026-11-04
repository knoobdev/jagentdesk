import { FakeJiraServer, type FakeDeployment } from "./fake-jira-server.js";

// Runs a fake Jira site as its own process for manual and built-daemon checks:
//   npx tsx src/server/jira/test-support/run-fake-jira.ts cloud
// Prints one JSON line with its URL and credentials, then serves until killed.

const deployment: FakeDeployment = process.argv[2] === "datacenter" ? "datacenter" : "cloud";
const fake = new FakeJiraServer({
  deployment,
  accessTokenTtlS: Number(process.env.FAKE_JIRA_TOKEN_TTL_S ?? 3600),
});
await fake.start();
process.stdout.write(
  `${JSON.stringify({
    deployment,
    baseUrl: fake.baseUrl,
    email: fake.me.email,
    apiToken: fake.apiToken,
    pat: fake.pat,
    clientId: fake.oauthClient.clientId,
    clientSecret: fake.oauthClient.clientSecret,
  })}\n`,
);
setInterval(() => {
  const refreshes = fake.tokenRequests.filter((r) => r.grantType === "refresh_token").length;
  process.stderr.write(`requests=${fake.requests.length} refreshes=${refreshes}\n`);
}, 10_000);
