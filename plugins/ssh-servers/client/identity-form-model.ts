import type { SshIdentity, SshKey } from "@jagentdesk/client/internal/daemon-client";

export interface SshIdentityFormDisplay {
  label: string;
}

export interface SshIdentityFormSnapshot {
  mode: "create" | "edit";
  identity?: SshIdentity;
  keys: readonly SshKey[];
}

export interface SshIdentityFormState {
  mode: SshIdentityFormSnapshot["mode"];
  label: string;
  username: string;
  keyId: string | null;
  keyDisplay: SshIdentityFormDisplay | null;
  passwordDraft: string;
  passwordDirty: boolean;
  hasStoredPassword: boolean;
  clearPasswordRequested: boolean;
  errors: { label?: string };
  canSubmit: boolean;
  submitError: string | null;
}

export interface SshIdentitySavePayloadInput {
  identity: SshIdentity;
  /** undefined keeps the stored secret, "" deletes it, non-empty replaces it. */
  password?: string;
}

export interface SshIdentityFormModel {
  getState: () => SshIdentityFormState;
  subscribe: (listener: () => void) => () => void;
  close: () => void;
  setLabel: (value: string) => void;
  setUsername: (value: string) => void;
  setKey: (keyId: string | null, display: SshIdentityFormDisplay | null) => void;
  setPasswordDraft: (value: string) => void;
  requestClearPassword: () => void;
  setSubmitError: (value: string | null) => void;
  buildSavePayload: () => SshIdentitySavePayloadInput | null;
}

export function buildSshKeyOptions(keys: readonly SshKey[]): { id: string; label: string }[] {
  return [...keys]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((key) => ({ id: key.id, label: key.label }));
}

export function openSshIdentityFormModel(snapshot: SshIdentityFormSnapshot): SshIdentityFormModel {
  const identity = snapshot.identity;
  let state: SshIdentityFormState = {
    mode: snapshot.mode,
    label: identity?.label ?? "",
    username: identity?.username ?? "",
    keyId: identity?.keyId ?? null,
    keyDisplay: keyDisplayFor(snapshot.keys, identity?.keyId),
    passwordDraft: "",
    passwordDirty: false,
    hasStoredPassword: identity?.hasPassword === true,
    clearPasswordRequested: false,
    errors: {},
    canSubmit: false,
    submitError: null,
  };

  const listeners = new Set<() => void>();
  let closed = false;

  const publish = (next: Partial<SshIdentityFormState>) => {
    if (closed) return;
    state = { ...state, ...next };
    state = { ...state, ...deriveIdentityErrors(state) };
    for (const listener of listeners) listener();
  };

  const model: SshIdentityFormModel = {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: () => {
      closed = true;
      listeners.clear();
    },
    setLabel: (value) => publish({ label: value }),
    setUsername: (value) => publish({ username: value }),
    setKey: (keyId, display) => publish({ keyId, keyDisplay: display }),
    setPasswordDraft: (value) =>
      publish({ passwordDraft: value, passwordDirty: true, clearPasswordRequested: false }),
    requestClearPassword: () =>
      publish({ passwordDraft: "", passwordDirty: false, clearPasswordRequested: true }),
    setSubmitError: (value) => publish({ submitError: value }),
    buildSavePayload: () => {
      if (!state.canSubmit) return null;
      const identityPayload: SshIdentity = {
        id: state.mode === "edit" && snapshot.identity ? snapshot.identity.id : "",
        label: state.label.trim(),
      };
      if (state.username.trim()) identityPayload.username = state.username.trim();
      if (state.keyId) identityPayload.keyId = state.keyId;
      const payload: SshIdentitySavePayloadInput = { identity: identityPayload };
      if (state.clearPasswordRequested) {
        payload.password = "";
      } else if (state.passwordDirty && state.passwordDraft.length > 0) {
        payload.password = state.passwordDraft;
      }
      return payload;
    },
  };

  publish({});
  return model;
}

function keyDisplayFor(keys: readonly SshKey[], keyId: string | undefined) {
  if (!keyId) return null;
  const key = keys.find((candidate) => candidate.id === keyId);
  return key ? { label: key.label } : null;
}

function deriveIdentityErrors(
  candidate: SshIdentityFormState,
): Pick<SshIdentityFormState, "errors" | "canSubmit"> {
  const errors: SshIdentityFormState["errors"] = {};
  if (!candidate.label.trim()) {
    errors.label = "Label is required";
  }
  return { errors, canSubmit: Object.keys(errors).length === 0 };
}
