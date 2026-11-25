import { describe, expect, it } from "vitest";
import type { ArgoCdManagedResource } from "@jagentdesk/protocol/argocd/rpc-schemas";
import { buildSyncRequestOptions, initialSyncForm, summarizeSync } from "./sync-form";

function resource(input: {
  kind: string;
  name: string;
  sync: string;
  requiresPruning?: boolean;
  hook?: boolean;
}): ArgoCdManagedResource {
  return {
    group: input.kind === "Deployment" ? "apps" : "",
    version: "v1",
    kind: input.kind,
    namespace: "web",
    name: input.name,
    sync: input.sync,
    health: null,
    hook: input.hook ?? false,
    requiresPruning: input.requiresPruning ?? false,
    requiresDeletionConfirmation: false,
  };
}

const app = {
  sources: [{ repoURL: "<repo-url>", path: "guestbook", chart: null, targetRevision: "main" }],
  syncOptions: ["CreateNamespace=true", "FailOnSharedResource=true"],
  resources: [
    resource({ kind: "Deployment", name: "ui", sync: "OutOfSync" }),
    resource({ kind: "Service", name: "ui", sync: "Synced" }),
    resource({ kind: "ConfigMap", name: "old", sync: "OutOfSync", requiresPruning: true }),
    resource({ kind: "Job", name: "migrate", sync: "OutOfSync", hook: true }),
  ],
};

describe("initialSyncForm", () => {
  it("starts from the app's target revision, its sync options and every non-hook resource", () => {
    const form = initialSyncForm(app);
    expect(form.revision).toBe("main");
    expect(form.flags.autoCreateNamespace).toBe(true);
    expect(form.flags.serverSideApply).toBe(false);
    expect(form.otherSyncOptions).toEqual(["FailOnSharedResource=true"]);
    expect([...form.selected]).toEqual([
      "apps/Deployment/web/ui",
      "/Service/web/ui",
      "/ConfigMap/web/old",
    ]);
  });
});

describe("buildSyncRequestOptions", () => {
  it("sends a plain sync of everything like `argocd app sync` without flags", () => {
    const form = initialSyncForm({ ...app, syncOptions: [] });
    expect(buildSyncRequestOptions(form, app)).toEqual({
      prune: false,
      dryRun: false,
      force: false,
      applyOnly: false,
      syncOptions: [],
    });
  });

  it("maps prune, one selected resource, options and a non-default revision", () => {
    const base = initialSyncForm(app);
    const form = {
      ...base,
      revision: "v2",
      prune: true,
      dryRun: true,
      flags: { ...base.flags, serverSideApply: true, skipSchemaValidation: true },
      prunePropagationPolicy: "orphan" as const,
      selected: new Set(["apps/Deployment/web/ui"]),
    };
    expect(buildSyncRequestOptions(form, app)).toEqual({
      revision: "v2",
      prune: true,
      dryRun: true,
      force: false,
      applyOnly: false,
      resources: [{ group: "apps", kind: "Deployment", namespace: "web", name: "ui" }],
      syncOptions: [
        "FailOnSharedResource=true",
        "Validate=false",
        "CreateNamespace=true",
        "ServerSideApply=true",
        "PrunePropagationPolicy=orphan",
      ],
    });
  });
});

describe("summarizeSync", () => {
  it("counts changes and prunes within the selection", () => {
    const form = initialSyncForm(app);
    expect(summarizeSync({ ...form, prune: true }, app.resources)).toEqual({
      selected: 3,
      changes: 1,
      prunes: 1,
      pruneSkipped: 0,
    });
  });

  it("reports prune candidates as skipped when Prune is off", () => {
    const form = initialSyncForm(app);
    expect(summarizeSync(form, app.resources)).toEqual({
      selected: 3,
      changes: 1,
      prunes: 0,
      pruneSkipped: 1,
    });
  });

  it("only counts selected resources", () => {
    const form = { ...initialSyncForm(app), prune: true, selected: new Set(["/Service/web/ui"]) };
    expect(summarizeSync(form, app.resources)).toEqual({
      selected: 1,
      changes: 0,
      prunes: 0,
      pruneSkipped: 0,
    });
  });
});
