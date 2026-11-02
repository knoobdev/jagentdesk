import { KubeConfig } from "@kubernetes/client-node";
import { describe, expect, it } from "vitest";
import {
  ContextNotFoundError,
  apiServerTarget,
  forwardedKubeconfig,
  selectContext,
  serverIdOfContext,
} from "./kubeconfig.js";

const SERVER_KUBECONFIG = `
apiVersion: v1
kind: Config
current-context: prod
clusters:
  - name: prod-cluster
    cluster:
      server: https://kube-api.internal:6443
      certificate-authority-data: Q0FEQVRB
  - name: k3s
    cluster:
      server: https://127.0.0.1:6443
      certificate-authority-data: Q0FEQVRB
users:
  - name: prod-admin
    user:
      token: <token>
  - name: k3s-admin
    user:
      token: <token>
contexts:
  - name: prod
    context: { cluster: prod-cluster, user: prod-admin, namespace: web }
  - name: k3s
    context: { cluster: k3s, user: k3s-admin }
`;

function load(yaml: string): KubeConfig {
  const config = new KubeConfig();
  config.loadFromString(yaml);
  return config;
}

describe("forwardedKubeconfig", () => {
  it("points the context at the local forward and keeps verifying the original host name", () => {
    const selected = selectContext(load(SERVER_KUBECONFIG), "prod");

    const forwarded = load(
      forwardedKubeconfig({ selected, serverId: "srv_a1b2c3", localPort: 51234 }),
    );

    expect(forwarded.getContexts()).toEqual([
      {
        name: "ssh-srv_a1b2c3-prod",
        cluster: "ssh-srv_a1b2c3-prod-cluster",
        user: "ssh-srv_a1b2c3-prod-user",
        namespace: "web",
      },
    ]);
    expect(forwarded.getCluster("ssh-srv_a1b2c3-prod-cluster")).toMatchObject({
      server: "https://127.0.0.1:51234",
      tlsServerName: "kube-api.internal",
      skipTLSVerify: false,
      caData: "Q0FEQVRB",
    });
    expect(forwarded.getUser("ssh-srv_a1b2c3-prod-user")?.token).toBe("<token>");
    expect(forwarded.getCurrentContext()).toBe("ssh-srv_a1b2c3-prod");
    expect(serverIdOfContext("ssh-srv_a1b2c3-prod")).toBe("srv_a1b2c3");
    expect(serverIdOfContext("docker-desktop")).toBeNull();
  });

  it("verifies an IP API server against its IP (no TLS server name)", () => {
    const selected = selectContext(load(SERVER_KUBECONFIG), "k3s");

    const forwarded = load(forwardedKubeconfig({ selected, serverId: "srv_x", localPort: 40000 }));

    expect(apiServerTarget(selected.cluster)).toEqual({ host: "127.0.0.1", port: 6443 });
    expect(forwarded.getCluster("ssh-srv_x-k3s-cluster")?.tlsServerName).toBeUndefined();
  });

  it("rejects a context the kubeconfig does not have", () => {
    expect(() => selectContext(load(SERVER_KUBECONFIG), "staging")).toThrow(
      new ContextNotFoundError("staging"),
    );
  });
});
