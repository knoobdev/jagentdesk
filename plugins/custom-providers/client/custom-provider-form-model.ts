import type {
  ApiProtocol,
  ApiProviderRecord,
  ApiProviderThinkingOption,
  ApiRoute,
  SaveApiProviderInput,
  TestApiProviderInput,
} from "./types";

// Plain form model for the custom API provider add/edit sheet (spec 34.8).
// Zero React imports, following the schedule form model pattern (docs/forms.md):
// openCustomProviderForm(snapshot) constructs, commands mutate, derived state
// (errors, canSubmit) is recomputed on every publish.

export interface SshServerOption {
  id: string;
  label: string;
}

export interface CustomProviderFormSnapshot {
  mode: "create" | "update";
  record: ApiProviderRecord | null;
  sshServers: readonly SshServerOption[];
}

export interface ModelRowDraft {
  /** Stable React key; stripped from the save payload. */
  rowKey: string;
  id: string;
  label: string;
  isDefault: boolean;
  thinkingOptions: ApiProviderThinkingOption[];
}

export type FieldError = "required" | "invalid";

export interface CustomProviderFormState {
  mode: "create" | "update";
  name: string;
  id: string;
  /** True once the user edited the ID by hand; auto-derivation stops then (create only). */
  idTouched: boolean;
  protocol: ApiProtocol;
  baseUrl: string;
  via: ApiRoute;
  sshServerId: string | null;
  apiKeyDraft: string;
  hasStoredKey: boolean;
  keyCleared: boolean;
  models: ModelRowDraft[];
  discoverStatus: "idle" | "pending" | "done" | "error";
  discoverError: string | null;
  sshServers: readonly SshServerOption[];
  errors: {
    name: FieldError | null;
    id: FieldError | null;
    baseUrl: FieldError | null;
    sshServerId: FieldError | null;
  };
  canSubmit: boolean;
}

export interface CustomProviderFormModel {
  getState: () => CustomProviderFormState;
  subscribe: (listener: () => void) => () => void;
  close: () => void;
  applySshServers: (servers: readonly SshServerOption[]) => void;
  setName: (value: string) => void;
  setId: (value: string) => void;
  setProtocol: (value: ApiProtocol) => void;
  setBaseUrl: (value: string) => void;
  setVia: (value: ApiRoute) => void;
  setSshServerId: (value: string | null) => void;
  setApiKeyDraft: (value: string) => void;
  clearApiKey: () => void;
  beginDiscover: () => void;
  applyDiscoverResult: (result: {
    ok: boolean;
    modelIds: string[];
    errorMessage: string | null;
  }) => void;
  addModelRow: () => void;
  updateModelRow: (index: number, patch: Partial<Pick<ModelRowDraft, "id" | "label">>) => void;
  removeModelRow: (index: number) => void;
  setDefaultModel: (index: number) => void;
  addThinkingOption: (rowIndex: number, value: string) => void;
  setDefaultThinkingOption: (rowIndex: number, optionId: string) => void;
  removeThinkingOption: (rowIndex: number, optionId: string) => void;
  buildSavePayload: () => SaveApiProviderInput;
  buildTestInput: () => TestApiProviderInput;
}

const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

let rowKeyCounter = 0;
function nextRowKey(): string {
  rowKeyCounter += 1;
  return `row-${rowKeyCounter}`;
}

/** Config.json provider IDs: lowercase alphanumeric with hyphens, starting with a letter. */
export function slugifyProviderId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "");
}

function cloneThinkingOption(option: ApiProviderThinkingOption): ApiProviderThinkingOption {
  return {
    id: option.id,
    label: option.label,
    ...(option.isDefault ? { isDefault: true } : {}),
  };
}

function cloneThinkingOptions(
  options: readonly ApiProviderThinkingOption[],
): ApiProviderThinkingOption[] {
  return options.map(cloneThinkingOption);
}

function cloneRow(row: ModelRowDraft): ModelRowDraft {
  return {
    rowKey: row.rowKey,
    id: row.id,
    label: row.label,
    isDefault: row.isDefault,
    thinkingOptions: cloneThinkingOptions(row.thinkingOptions),
  };
}

/** Trim ids/labels; drop empty rows (save payload only — draft rows stay editable). */
function normalizeRow(row: ModelRowDraft): ModelRowDraft {
  return {
    rowKey: row.rowKey,
    id: row.id.trim(),
    label: row.label.trim() || row.id.trim(),
    isDefault: row.isDefault,
    thinkingOptions: cloneThinkingOptions(row.thinkingOptions),
  };
}

function normalizeModelRows(rows: readonly ModelRowDraft[]): ModelRowDraft[] {
  return rows.filter((row) => row.id.trim().length > 0).map(normalizeRow);
}

/** Rows being edited may be empty; only the default flag is repaired here. */
function ensureDefault(rows: readonly ModelRowDraft[]): ModelRowDraft[] {
  if (rows.length > 0 && !rows.some((row) => row.isDefault)) {
    const next = rows.slice();
    next[0] = { ...next[0], isDefault: true };
    return next;
  }
  return [...rows];
}

/**
 * Merge discovered model IDs into the edited rows: existing rows keep their
 * label, default flag and thinking options; newly discovered IDs are appended
 * with label = id; user-added rows that the endpoint did not list stay.
 */
export function mergeDiscoveredModels(
  existing: readonly ModelRowDraft[],
  discoveredIds: readonly string[],
): ModelRowDraft[] {
  const knownIds = new Set(existing.map((row) => row.id.trim()));
  const rows = existing.map(cloneRow);
  for (const id of discoveredIds) {
    const trimmed = id.trim();
    if (!trimmed || knownIds.has(trimmed)) {
      continue;
    }
    knownIds.add(trimmed);
    rows.push({
      rowKey: nextRowKey(),
      id: trimmed,
      label: trimmed,
      isDefault: false,
      thinkingOptions: [],
    });
  }
  return ensureDefault(normalizeModelRows(rows));
}

function resolveErrors(state: CustomProviderFormState): CustomProviderFormState["errors"] {
  const name = state.name.trim().length > 0 ? null : "required";
  const id = PROVIDER_ID_PATTERN.test(state.id.trim()) ? null : "invalid";
  const baseUrl = /^https?:\/\/\S+/.test(state.baseUrl.trim()) ? null : "invalid";
  const sshServerId = state.via === "ssh" && !state.sshServerId?.trim() ? "required" : null;
  return { name, id, baseUrl, sshServerId };
}

function resolveCanSubmit(state: CustomProviderFormState): boolean {
  const errors = resolveErrors(state);
  return !errors.name && !errors.id && !errors.baseUrl && !errors.sshServerId;
}

function withDerivedState(state: CustomProviderFormState): CustomProviderFormState {
  const errors = resolveErrors(state);
  return { ...state, errors, canSubmit: resolveCanSubmit(state) };
}

/** undefined = keep the stored key; "" = delete it; otherwise replace it. */
function resolveApiKey(state: CustomProviderFormState): string | undefined {
  if (state.mode === "create") {
    const draft = state.apiKeyDraft.trim();
    return draft.length > 0 ? draft : undefined;
  }
  if (state.keyCleared) {
    return "";
  }
  const draft = state.apiKeyDraft.trim();
  return draft.length > 0 ? draft : undefined;
}

function toThinkingPayload(option: ApiProviderThinkingOption): ApiProviderThinkingOption {
  return cloneThinkingOption(option);
}

function toModelPayload(row: ModelRowDraft) {
  return {
    id: row.id,
    label: row.label,
    ...(row.isDefault ? { isDefault: true } : {}),
    ...(row.thinkingOptions.length > 0
      ? { thinkingOptions: row.thinkingOptions.map(toThinkingPayload) }
      : {}),
  };
}

function buildInitialState(snapshot: CustomProviderFormSnapshot): CustomProviderFormState {
  const record = snapshot.mode === "update" ? snapshot.record : null;
  const models = record
    ? normalizeModelRows(
        record.models.map((model, index) => ({
          rowKey: `seed-${index}`,
          id: model.id,
          label: model.label,
          isDefault: model.isDefault === true,
          thinkingOptions: cloneThinkingOptions(model.thinkingOptions ?? []),
        })),
      )
    : [];
  return withDerivedState({
    mode: snapshot.mode,
    name: record?.label ?? "",
    id: record?.id ?? "",
    idTouched: record !== null,
    protocol: record?.protocol ?? "openai",
    baseUrl: record?.baseUrl ?? "",
    via: record?.via ?? "direct",
    sshServerId: record?.sshServerId ?? null,
    apiKeyDraft: "",
    hasStoredKey: record?.hasApiKey === true,
    keyCleared: false,
    models,
    discoverStatus: "idle",
    discoverError: null,
    sshServers: [...snapshot.sshServers],
    errors: { name: null, id: null, baseUrl: null, sshServerId: null },
    canSubmit: false,
  });
}

export function openCustomProviderForm(
  snapshot: CustomProviderFormSnapshot,
): CustomProviderFormModel {
  const listeners = new Set<() => void>();
  let closed = false;
  let sshServers = [...snapshot.sshServers];
  let state = buildInitialState(snapshot);

  function publish(nextState: CustomProviderFormState): void {
    if (closed) {
      return;
    }
    state = withDerivedState(nextState);
    for (const listener of listeners) {
      listener();
    }
  }

  function publishModels(nextRows: ModelRowDraft[]): void {
    publish({ ...state, models: ensureDefault(nextRows) });
  }

  function updateThinkingOptions(
    rowIndex: number,
    transform: (options: ApiProviderThinkingOption[]) => ApiProviderThinkingOption[],
  ): void {
    if (closed || rowIndex < 0 || rowIndex >= state.models.length) {
      return;
    }
    const rows = state.models.map((row, index) =>
      index === rowIndex ? { ...row, thinkingOptions: transform(row.thinkingOptions) } : row,
    );
    publishModels(rows);
  }

  return {
    getState: () => state,
    subscribe(listener) {
      if (closed) {
        return () => {};
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      closed = true;
      listeners.clear();
    },
    applySshServers(nextServers) {
      if (closed || sshServers === nextServers) {
        return;
      }
      sshServers = [...nextServers];
      publish({ ...state, sshServers });
    },
    setName(value) {
      if (closed) {
        return;
      }
      const autoId =
        state.mode === "create" && !state.idTouched ? slugifyProviderId(value) : state.id;
      publish({ ...state, name: value, id: autoId });
    },
    setId(value) {
      if (closed || state.mode === "update") {
        return;
      }
      publish({ ...state, id: value, idTouched: true });
    },
    setProtocol(value) {
      if (closed) {
        return;
      }
      publish({ ...state, protocol: value });
    },
    setBaseUrl(value) {
      if (closed) {
        return;
      }
      publish({ ...state, baseUrl: value });
    },
    setVia(value) {
      if (closed) {
        return;
      }
      publish({ ...state, via: value });
    },
    setSshServerId(value) {
      if (closed) {
        return;
      }
      publish({ ...state, sshServerId: value });
    },
    setApiKeyDraft(value) {
      if (closed) {
        return;
      }
      publish({ ...state, apiKeyDraft: value, keyCleared: false });
    },
    clearApiKey() {
      if (closed || state.mode !== "update") {
        return;
      }
      publish({ ...state, apiKeyDraft: "", keyCleared: true });
    },
    beginDiscover() {
      if (closed) {
        return;
      }
      publish({ ...state, discoverStatus: "pending", discoverError: null });
    },
    applyDiscoverResult(result) {
      if (closed) {
        return;
      }
      if (!result.ok) {
        publish({
          ...state,
          discoverStatus: "error",
          discoverError: result.errorMessage ?? "",
        });
        return;
      }
      publish({
        ...state,
        discoverStatus: "done",
        discoverError: null,
        models: mergeDiscoveredModels(state.models, result.modelIds),
      });
    },
    addModelRow() {
      if (closed) {
        return;
      }
      publishModels([
        ...state.models,
        { rowKey: nextRowKey(), id: "", label: "", isDefault: false, thinkingOptions: [] },
      ]);
    },
    updateModelRow(index, patch) {
      if (closed || index < 0 || index >= state.models.length) {
        return;
      }
      const rows = state.models.map((row, rowIndex) =>
        rowIndex === index ? { ...row, ...patch } : row,
      );
      publishModels(rows);
    },
    removeModelRow(index) {
      if (closed || index < 0 || index >= state.models.length) {
        return;
      }
      publishModels(state.models.filter((_, rowIndex) => rowIndex !== index));
    },
    setDefaultModel(index) {
      if (closed || index < 0 || index >= state.models.length) {
        return;
      }
      publishModels(
        state.models.map((row, rowIndex) => ({ ...row, isDefault: rowIndex === index })),
      );
    },
    addThinkingOption(rowIndex, value) {
      const id = value.trim();
      if (!id) {
        return;
      }
      updateThinkingOptions(rowIndex, (options) =>
        options.some((option) => option.id === id) ? options : [...options, { id, label: id }],
      );
    },
    setDefaultThinkingOption(rowIndex, optionId) {
      updateThinkingOptions(rowIndex, (options) =>
        options.map((option) => ({ ...option, isDefault: option.id === optionId })),
      );
    },
    removeThinkingOption(rowIndex, optionId) {
      updateThinkingOptions(rowIndex, (options) =>
        options.filter((option) => option.id !== optionId),
      );
    },
    buildSavePayload() {
      const models = normalizeModelRows(state.models).map(toModelPayload);
      const provider: SaveApiProviderInput["provider"] = {
        id: state.id.trim(),
        label: state.name.trim(),
        protocol: state.protocol,
        baseUrl: state.baseUrl.trim(),
        via: state.via,
      };
      if (state.via === "ssh" && state.sshServerId?.trim()) {
        provider.sshServerId = state.sshServerId.trim();
      }
      if (state.mode === "update" || models.length > 0) {
        provider.models = models;
      }
      const apiKey = resolveApiKey(state);
      return {
        mode: state.mode,
        provider,
        ...(apiKey !== undefined ? { apiKey } : {}),
      };
    },
    buildTestInput() {
      const input: TestApiProviderInput = {
        protocol: state.protocol,
        baseUrl: state.baseUrl.trim(),
        via: state.via,
      };
      if (state.via === "ssh" && state.sshServerId?.trim()) {
        input.sshServerId = state.sshServerId.trim();
      }
      const apiKey = state.apiKeyDraft.trim();
      if (apiKey) {
        input.apiKey = apiKey;
      }
      if (state.mode === "update") {
        input.id = state.id.trim();
      }
      return input;
    },
  };
}
