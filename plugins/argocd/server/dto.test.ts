import { describe, expect, it } from "vitest";
import { toCluster, toRepo } from "./dto.js";

// Criterion 30.6.9: repository and cluster payloads go through an allowlist.
describe("allowlist mapping", () => {
  it("keeps only identity and connection state of a repository", () => {
    const raw = {
      repo: "https://git.invalid/org/app.git",
      type: "git",
      name: "app",
      project: "default",
      username: "ci-bot",
      password: "pw-value",
      sshPrivateKey: "key-value",
      tlsClientCertData: "cert-value",
      tlsClientCertKey: "certkey-value",
      githubAppPrivateKey: "gh-value",
      bearerToken: "bearer-value",
      gcpServiceAccountKey: "gcp-value",
      azureServicePrincipalClientSecret: "azure-value",
      proxy: "http://user:proxy-value@proxy.invalid:3128",
      insecure: false,
      enableLfs: true,
      enableOCI: false,
      inheritedCreds: true,
      connectionState: { status: "Successful", message: "", attemptedAt: "2026-11-03T20:00:00Z" },
    };

    const repo = toRepo(raw);

    expect(repo).toEqual({
      repo: "https://git.invalid/org/app.git",
      type: "git",
      name: "app",
      project: "default",
      insecure: false,
      enableLfs: true,
      enableOci: false,
      inheritedCreds: true,
      connectionState: { status: "Successful", message: null, attemptedAt_ms: 1793736000000 },
    });
    expect(JSON.stringify(repo)).not.toMatch(/-value/);
  });

  it("never copies a cluster's config", () => {
    const cluster = toCluster({
      server: "https://kubernetes.default.svc",
      name: "in-cluster",
      config: { bearerToken: "bearer-value", tlsClientConfig: { keyData: "key-value" } },
      info: {
        serverVersion: "1.34",
        applicationsCount: 3,
        connectionState: { status: "Successful" },
      },
    });

    expect(JSON.stringify(cluster)).not.toMatch(/-value/);
    expect(cluster.serverVersion).toBe("1.34");
    expect(cluster.applicationsCount).toBe(3);
  });
});
