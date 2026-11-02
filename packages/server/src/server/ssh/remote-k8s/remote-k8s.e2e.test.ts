import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClusterRegistry } from "../../cluster/cluster-registry.js";
import { MemorySecretStore } from "../../database/secret-store.js";
import { execCommand } from "../../../utils/spawn.js";
import { runRemoteCommand } from "../environment/remote-exec.js";
import { writeRemoteFile } from "../environment/remote-files.js";
import { createTestSshPool, type TestSshPool } from "../environment/test-sshd.js";
import { setSshdOption } from "../remote-docker/test-remote-docker.js";
import { handleSshRemoteK8sMessage } from "./rpc.js";
import { RemoteK8sClusters } from "./service.js";

// The API server is Docker Desktop's Kubernetes control plane, joined to the test sshd through
// the `kind` network: the server reaches https://desktop-control-plane:6443 (a name in the API
// certificate), this machine cannot even resolve that name.
const API_HOST = "desktop-control-plane";
const SSHD = "jad-sshd-envdocker";

interface KubectlConfig {
  clusters: Array<{ cluster: Record<string, string> }>;
  users: Array<{ user: Record<string, string> }>;
}

async function run(command: string, args: string[]): Promise<string> {
  return (await execCommand(command, args, { timeout: 60_000 })).stdout.trim();
}

async function remote(pool: TestSshPool, command: string): Promise<void> {
  const { client } = await pool.acquire("srv_e2e");
  await runRemoteCommand(client, { command, timeoutMs: 20_000, maxBytesPerStream: 4096 });
}

describe("Kubernetes through an SSH server", () => {
  let pool: TestSshPool;
  let runDirectory: string;
  let clusters: RemoteK8sClusters;
  const originalKubeconfig = process.env.KUBECONFIG;

  beforeAll(async () => {
    await run("docker", ["network", "connect", "kind", SSHD]).catch(() => "");
    await setSshdOption("AllowTcpForwarding", "yes");
    pool = createTestSshPool();
    runDirectory = path.join(mkdtempSync(path.join(tmpdir(), "jad-rk8s-")), "run");
    clusters = new RemoteK8sClusters({
      acquire: pool.acquire,
      secrets: new MemorySecretStore(),
      runDirectory,
    });
    const local = JSON.parse(
      await run("kubectl", [
        "config",
        "view",
        "--raw",
        "--minify",
        "--flatten",
        "--context",
        "docker-desktop",
        "-o",
        "json",
      ]),
    ) as KubectlConfig;
    const ca = Buffer.from(local.clusters[0].cluster["certificate-authority-data"], "base64");
    const user = local.users[0].user;
    // CA as a file on the server, credentials inline: both shapes kubeconfigs use.
    const kubeconfig = [
      "apiVersion: v1",
      "kind: Config",
      "current-context: remote-ctx",
      "clusters:",
      "- name: desktop",
      "  cluster:",
      `    server: https://${API_HOST}:6443`,
      "    certificate-authority: /config/.kube/ca.crt",
      "users:",
      "- name: desktop-user",
      "  user:",
      `    client-certificate-data: ${user["client-certificate-data"]}`,
      `    client-key-data: ${user["client-key-data"]}`,
      "contexts:",
      "- name: remote-ctx",
      "  context: { cluster: desktop, user: desktop-user }",
      "",
    ].join("\n");
    await remote(pool, "mkdir -p /config/.kube");
    const { client } = await pool.acquire("srv_e2e");
    await writeRemoteFile(client, { path: "/config/.kube/ca.crt", content: ca.toString("utf8") });
    await writeRemoteFile(client, { path: ".kube/config", content: kubeconfig });
  });

  afterAll(async () => {
    await clusters.remove("ssh-srv_e2e-remote-ctx");
    await remote(pool, "rm -rf /config/.kube");
    pool.close();
    if (originalKubeconfig === undefined) delete process.env.KUBECONFIG;
    else process.env.KUBECONFIG = originalKubeconfig;
    await run("docker", ["network", "disconnect", "kind", SSHD]).catch(() => "");
    await setSshdOption("AllowTcpForwarding", "no");
    rmSync(path.dirname(runDirectory), { recursive: true, force: true });
  });

  it("imports a server-only cluster that the Clusters feature then connects to with TLS", async () => {
    const emitted: unknown[] = [];
    const request = {
      type: "ssh.remote_k8s.import.request",
      requestId: "req_1",
      serverId: "srv_e2e",
      kubeconfigPath: ".kube/config",
      context: "remote-ctx",
    };

    await handleSshRemoteK8sMessage(clusters, request, (message) => emitted.push(message));
    const registry = new ClusterRegistry();
    const info = registry.importContext("ssh-srv_e2e-remote-ctx", "remote-ctx (srv_e2e)");
    const connected = await registry.connect(info.id);
    await registry.disconnect(info.id);
    const file = path.join(runDirectory, "kube-ssh-srv_e2e-remote-ctx.json");
    const written = JSON.parse(readFileSync(file, "utf8")) as {
      clusters: Array<{ cluster: Record<string, unknown> }>;
    };

    await expect(lookup(API_HOST)).rejects.toThrow();
    expect(emitted).toEqual([
      {
        type: "ssh.remote_k8s.import.response",
        payload: {
          requestId: "req_1",
          serverId: "srv_e2e",
          clusterInput: {
            contextName: "ssh-srv_e2e-remote-ctx",
            displayName: "remote-ctx (srv_e2e)",
          },
          error: null,
          errorCode: null,
        },
      },
    ]);
    const nodes = await run("kubectl", [
      "--context",
      "docker-desktop",
      "get",
      "nodes",
      "-o",
      "name",
    ]);
    expect(connected).toMatchObject({ state: "connected", nodeCount: nodes.split("\n").length });
    expect(written.clusters[0].cluster).toMatchObject({
      server: expect.stringMatching(/^https:\/\/127\.0\.0\.1:\d+$/),
      "tls-server-name": API_HOST,
      "insecure-skip-tls-verify": false,
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(runDirectory).mode & 0o777).toBe(0o700);
  });

  it("removes the runtime kubeconfig on deactivate and restores it on activate", async () => {
    const file = path.join(runDirectory, "kube-ssh-srv_e2e-remote-ctx.json");

    await clusters.deactivate("ssh-srv_e2e-remote-ctx");
    const goneAfterDeactivate = !existsSync(file);
    const offPath = !(process.env.KUBECONFIG ?? "").includes(file);
    await clusters.activate("ssh-srv_e2e-remote-ctx");
    const registry = new ClusterRegistry();
    const info = registry.importContext("ssh-srv_e2e-remote-ctx");
    const connected = await registry.connect(info.id);
    await registry.disconnect(info.id);

    expect(goneAfterDeactivate).toBe(true);
    expect(offPath).toBe(true);
    expect(connected.state).toBe("connected");
  });

  it("reports context_not_found and kubeconfig_unreadable", async () => {
    await expect(
      clusters.import({ serverId: "srv_e2e", kubeconfigPath: ".kube/config", context: "staging" }),
    ).rejects.toMatchObject({ code: "context_not_found" });
    await expect(
      clusters.import({
        serverId: "srv_e2e",
        kubeconfigPath: ".kube/missing",
        context: "remote-ctx",
      }),
    ).rejects.toMatchObject({ code: "kubeconfig_unreadable" });
  });
});
