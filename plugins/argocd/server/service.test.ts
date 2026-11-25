import { describe, expect, it } from "vitest";
import type { ArgoCdAppDetail } from "@jagentdesk/protocol/argocd/rpc-schemas";
import { buildSyncBody, normalizeServerUrl, previewSync } from "./service.js";

describe("buildSyncBody", () => {
  it("matches `argocd app sync guestbook --prune --resource apps:Deployment:guestbook/guestbook-ui`", () => {
    const body = buildSyncBody({ name: "guestbook", appNamespace: null }, "default", {
      prune: true,
      dryRun: false,
      force: false,
      applyOnly: false,
      resources: [
        { group: "apps", kind: "Deployment", namespace: "guestbook", name: "guestbook-ui" },
      ],
      syncOptions: [],
    });

    expect(body).toEqual({
      name: "guestbook",
      project: "default",
      prune: true,
      dryRun: false,
      strategy: { hook: { force: false } },
      resources: [
        { group: "apps", kind: "Deployment", name: "guestbook-ui", namespace: "guestbook" },
      ],
    });
  });

  it("maps apply-only, force, revision, sync options and the app namespace", () => {
    const body = buildSyncBody({ name: "web", appNamespace: "team-a" }, "team-a", {
      revision: "v1.2.0",
      prune: false,
      dryRun: true,
      force: true,
      applyOnly: true,
      syncOptions: ["ApplyOutOfSyncOnly=true", "ServerSideApply=true"],
    });

    expect(body).toEqual({
      name: "web",
      appNamespace: "team-a",
      project: "team-a",
      revision: "v1.2.0",
      prune: false,
      dryRun: true,
      strategy: { apply: { force: true } },
      syncOptions: { items: ["ApplyOutOfSyncOnly=true", "ServerSideApply=true"] },
    });
  });
});

describe("previewSync", () => {
  const resource = (name: string, sync: string, requiresPruning: boolean) => ({
    group: "",
    version: "v1",
    kind: "ConfigMap",
    namespace: "ns",
    name,
    sync,
    health: null,
    hook: false,
    requiresPruning,
    requiresDeletionConfirmation: false,
  });
  const app = {
    resources: [
      resource("a", "Synced", false),
      resource("b", "OutOfSync", false),
      resource("c", "OutOfSync", true),
    ],
  } as Pick<ArgoCdAppDetail, "resources">;

  it("counts changes and prunes, and prunes nothing when prune is off", () => {
    const base = { dryRun: false, force: false, applyOnly: false, syncOptions: [] };
    expect(previewSync(app, { ...base, prune: true })).toEqual({
      toChange: 1,
      toPrune: 1,
      resources: ["ConfigMap/ns/b", "ConfigMap/ns/c (prune)"],
    });
    expect(previewSync(app, { ...base, prune: false }).toPrune).toBe(0);
    expect(
      previewSync(app, {
        ...base,
        prune: true,
        resources: [{ group: "", kind: "ConfigMap", namespace: "ns", name: "c" }],
      }),
    ).toEqual({ toChange: 0, toPrune: 1, resources: ["ConfigMap/ns/c (prune)"] });
  });
});

describe("normalizeServerUrl", () => {
  it("compares API servers by scheme, lower-case host and port", () => {
    expect(normalizeServerUrl("https://K8S.Example:443/")).toBe(
      normalizeServerUrl("https://k8s.example"),
    );
    expect(normalizeServerUrl("https://127.0.0.1:6443")).not.toBe(
      normalizeServerUrl("https://127.0.0.1:443"),
    );
  });
});
