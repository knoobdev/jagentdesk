import type {
  ArgoCdAppDetail,
  ArgoCdManagedResource,
  ArgoCdSyncRequestOptions,
} from "@jagentdesk/protocol/argocd/rpc-schemas";
import { resourceKeyId } from "./resources";

// The Synchronize panel (spec 30.3, reference §1.3): form state, the request it sends, and the
// "N will change, M will be pruned" summary shown before confirming.

export type SyncOptionFlag =
  | "skipSchemaValidation"
  | "autoCreateNamespace"
  | "pruneLast"
  | "applyOutOfSyncOnly"
  | "respectIgnoreDifferences"
  | "serverSideApply"
  | "replace";

export interface SyncOptionDefinition {
  flag: SyncOptionFlag;
  label: string;
  option: string;
}

export const SYNC_OPTION_DEFINITIONS: readonly SyncOptionDefinition[] = [
  { flag: "skipSchemaValidation", label: "Skip schema validation", option: "Validate=false" },
  { flag: "autoCreateNamespace", label: "Auto-create namespace", option: "CreateNamespace=true" },
  { flag: "pruneLast", label: "Prune last", option: "PruneLast=true" },
  {
    flag: "applyOutOfSyncOnly",
    label: "Apply out of sync only",
    option: "ApplyOutOfSyncOnly=true",
  },
  {
    flag: "respectIgnoreDifferences",
    label: "Respect ignore differences",
    option: "RespectIgnoreDifferences=true",
  },
  { flag: "serverSideApply", label: "Server-side apply", option: "ServerSideApply=true" },
  { flag: "replace", label: "Replace", option: "Replace=true" },
];

export type PrunePropagationPolicy = "foreground" | "background" | "orphan";

export const PRUNE_PROPAGATION_POLICIES: readonly PrunePropagationPolicy[] = [
  "foreground",
  "background",
  "orphan",
];

const PRUNE_POLICY_PREFIX = "PrunePropagationPolicy=";
const DEFAULT_PRUNE_POLICY: PrunePropagationPolicy = "foreground";

export interface SyncFormState {
  revision: string;
  prune: boolean;
  dryRun: boolean;
  applyOnly: boolean;
  force: boolean;
  flags: Readonly<Record<SyncOptionFlag, boolean>>;
  prunePropagationPolicy: PrunePropagationPolicy;
  /** App sync options this panel has no control for; sent through unchanged. */
  otherSyncOptions: readonly string[];
  /** Selected resources by `resourceKeyId`. */
  selected: ReadonlySet<string>;
}

/** Resources the panel lists: hooks run on their own and are not selectable. */
export function syncableResources(
  resources: readonly ArgoCdManagedResource[],
): ArgoCdManagedResource[] {
  return resources.filter((resource) => !resource.hook);
}

/** The revision the app tracks; the field's default. */
export function defaultSyncRevision(app: Pick<ArgoCdAppDetail, "sources">): string {
  return app.sources[0]?.targetRevision || "HEAD";
}

function parsePrunePolicy(option: string): PrunePropagationPolicy | null {
  if (!option.startsWith(PRUNE_POLICY_PREFIX)) return null;
  const value = option.slice(PRUNE_POLICY_PREFIX.length);
  return PRUNE_PROPAGATION_POLICIES.find((policy) => policy === value) ?? null;
}

// Like Argo CD's panel, the checkboxes start from the app's own `syncPolicy.syncOptions`.
export function initialSyncForm(
  app: Pick<ArgoCdAppDetail, "sources" | "syncOptions" | "resources">,
): SyncFormState {
  const flags: Record<SyncOptionFlag, boolean> = {
    skipSchemaValidation: false,
    autoCreateNamespace: false,
    pruneLast: false,
    applyOutOfSyncOnly: false,
    respectIgnoreDifferences: false,
    serverSideApply: false,
    replace: false,
  };
  let prunePropagationPolicy = DEFAULT_PRUNE_POLICY;
  const otherSyncOptions: string[] = [];
  for (const option of app.syncOptions) {
    const definition = SYNC_OPTION_DEFINITIONS.find((entry) => entry.option === option);
    const policy = parsePrunePolicy(option);
    if (definition) flags[definition.flag] = true;
    else if (policy) prunePropagationPolicy = policy;
    else otherSyncOptions.push(option);
  }
  return {
    revision: defaultSyncRevision(app),
    prune: false,
    dryRun: false,
    applyOnly: false,
    force: false,
    flags,
    prunePropagationPolicy,
    otherSyncOptions,
    selected: new Set(syncableResources(app.resources).map(resourceKeyId)),
  };
}

export function buildSyncRequestOptions(
  form: SyncFormState,
  app: Pick<ArgoCdAppDetail, "sources" | "resources">,
): ArgoCdSyncRequestOptions {
  const syncOptions = [...form.otherSyncOptions];
  for (const definition of SYNC_OPTION_DEFINITIONS) {
    if (form.flags[definition.flag]) syncOptions.push(definition.option);
  }
  if (form.prunePropagationPolicy !== DEFAULT_PRUNE_POLICY) {
    syncOptions.push(`${PRUNE_POLICY_PREFIX}${form.prunePropagationPolicy}`);
  }

  const syncable = syncableResources(app.resources);
  const selected = syncable.filter((resource) => form.selected.has(resourceKeyId(resource)));
  const isSelective = selected.length < syncable.length;
  const revision = form.revision.trim();
  const isOtherRevision = revision.length > 0 && revision !== defaultSyncRevision(app);

  return {
    ...(isOtherRevision ? { revision } : {}),
    prune: form.prune,
    dryRun: form.dryRun,
    force: form.force,
    applyOnly: form.applyOnly,
    ...(isSelective
      ? {
          resources: selected.map(({ group, kind, namespace, name }) => ({
            group,
            kind,
            namespace,
            name,
          })),
        }
      : {}),
    syncOptions,
  };
}

export interface SyncSummary {
  selected: number;
  /** Selected resources that are not Synced and will be applied. */
  changes: number;
  /** Selected resources that need pruning and will be deleted (Prune is on). */
  prunes: number;
  /** Selected resources that need pruning but are kept because Prune is off. */
  pruneSkipped: number;
}

export function summarizeSync(
  form: Pick<SyncFormState, "prune" | "selected">,
  resources: readonly ArgoCdManagedResource[],
): SyncSummary {
  const selected = syncableResources(resources).filter((resource) =>
    form.selected.has(resourceKeyId(resource)),
  );
  const pruneCandidates = selected.filter((resource) => resource.requiresPruning);
  const changes = selected.filter(
    (resource) => resource.sync !== "Synced" && !resource.requiresPruning,
  );
  return {
    selected: selected.length,
    changes: changes.length,
    prunes: form.prune ? pruneCandidates.length : 0,
    pruneSkipped: form.prune ? 0 : pruneCandidates.length,
  };
}
