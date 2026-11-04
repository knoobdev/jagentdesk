import type {
  ArgoCdAuthMethod,
  ArgoCdInstance,
  ArgoCdInstanceInput,
} from "@jagentdesk/protocol/argocd/rpc-schemas";

// Add / edit an Argo CD instance (spec 30.2, 30.2.3): plain model + reducer, seeded once per
// open from the instance being edited. Secrets are write-only: blank keeps what the daemon
// stores, so the edit form never shows (or needs) a stored value.

export interface HeaderDraft {
  key: string;
  name: string;
  value: string;
  /** The daemon already stores a value for this name; blank keeps it. */
  stored: boolean;
}

export interface InstanceFormState {
  id: string;
  url: string;
  displayName: string;
  authMethod: ArgoCdAuthMethod;
  username: string;
  rememberPassword: boolean;
  tlsSkipVerify: boolean;
  /** Password or API token, used to sign in right after saving. Never stored by the app. */
  secret: string;
  caPem: string;
  hasClientCert: boolean;
  clientCertPem: string;
  clientKeyPem: string;
  removeClientCert: boolean;
  headers: HeaderDraft[];
  nextHeaderKey: number;
  advancedOpen: boolean;
}

export type InstanceFormAction =
  | { type: "setUrl"; value: string }
  | { type: "setDisplayName"; value: string }
  | { type: "setAuthMethod"; value: ArgoCdAuthMethod }
  | { type: "setUsername"; value: string }
  | { type: "setRememberPassword"; value: boolean }
  | { type: "setTlsSkipVerify"; value: boolean }
  | { type: "setSecret"; value: string }
  | { type: "setCaPem"; value: string }
  | { type: "setClientCertPem"; value: string }
  | { type: "setClientKeyPem"; value: string }
  | { type: "toggleRemoveClientCert" }
  | { type: "addHeader" }
  | { type: "setHeaderName"; key: string; value: string }
  | { type: "setHeaderValue"; key: string; value: string }
  | { type: "removeHeader"; key: string }
  | { type: "toggleAdvanced" }
  | { type: "saved"; id: string };

const NEW_INSTANCE_FORM: InstanceFormState = {
  id: "",
  url: "",
  displayName: "",
  authMethod: "password",
  username: "",
  rememberPassword: false,
  tlsSkipVerify: false,
  secret: "",
  caPem: "",
  hasClientCert: false,
  clientCertPem: "",
  clientKeyPem: "",
  removeClientCert: false,
  headers: [],
  nextHeaderKey: 0,
  advancedOpen: false,
};

export function openInstanceForm(instance: ArgoCdInstance | null): InstanceFormState {
  if (!instance) return NEW_INSTANCE_FORM;
  const headers = instance.headerNames.map((name, index) => ({
    key: `h${index}`,
    name,
    value: "",
    stored: true,
  }));
  return {
    ...NEW_INSTANCE_FORM,
    id: instance.id,
    url: instance.url,
    displayName: instance.displayName,
    authMethod: instance.authMethod,
    username: instance.username ?? "",
    rememberPassword: instance.rememberPassword,
    tlsSkipVerify: instance.tlsSkipVerify,
    caPem: instance.caPem ?? "",
    hasClientCert: instance.hasClientCert,
    headers,
    nextHeaderKey: headers.length,
    advancedOpen: Boolean(instance.caPem) || instance.hasClientCert || headers.length > 0,
  };
}

function updateHeader(
  state: InstanceFormState,
  key: string,
  patch: Partial<HeaderDraft>,
): InstanceFormState {
  return {
    ...state,
    headers: state.headers.map((header) => (header.key === key ? { ...header, ...patch } : header)),
  };
}

export function reduceInstanceForm(
  state: InstanceFormState,
  action: InstanceFormAction,
): InstanceFormState {
  switch (action.type) {
    case "setUrl":
      return { ...state, url: action.value };
    case "setDisplayName":
      return { ...state, displayName: action.value };
    case "setAuthMethod":
      return { ...state, authMethod: action.value, secret: "" };
    case "setUsername":
      return { ...state, username: action.value };
    case "setRememberPassword":
      return { ...state, rememberPassword: action.value };
    case "setTlsSkipVerify":
      return { ...state, tlsSkipVerify: action.value };
    case "setSecret":
      return { ...state, secret: action.value };
    case "setCaPem":
      return { ...state, caPem: action.value };
    case "setClientCertPem":
      return { ...state, clientCertPem: action.value };
    case "setClientKeyPem":
      return { ...state, clientKeyPem: action.value };
    case "toggleRemoveClientCert":
      return { ...state, removeClientCert: !state.removeClientCert };
    case "addHeader":
      return {
        ...state,
        headers: [
          ...state.headers,
          { key: `h${state.nextHeaderKey}`, name: "", value: "", stored: false },
        ],
        nextHeaderKey: state.nextHeaderKey + 1,
      };
    case "setHeaderName":
      return updateHeader(state, action.key, { name: action.value });
    case "setHeaderValue":
      return updateHeader(state, action.key, { value: action.value });
    case "removeHeader":
      return { ...state, headers: state.headers.filter((header) => header.key !== action.key) };
    case "toggleAdvanced":
      return { ...state, advancedOpen: !state.advancedOpen };
    case "saved":
      return { ...state, id: action.id };
  }
}

export type InstanceFormError = "url_required" | "url_invalid" | "client_pair_incomplete";

export const INSTANCE_FORM_ERRORS: Record<InstanceFormError, string> = {
  url_required: "Enter the Argo CD URL",
  url_invalid: "Use an https:// or http:// URL",
  client_pair_incomplete: "Paste both the client certificate and its key",
};

export function validateInstanceForm(state: InstanceFormState): InstanceFormError | null {
  const url = state.url.trim();
  if (!url) return "url_required";
  if (!/^https?:\/\/\S+$/.test(url)) return "url_invalid";
  const hasCert = state.clientCertPem.trim().length > 0;
  const hasKey = state.clientKeyPem.trim().length > 0;
  if (!state.removeClientCert && hasCert !== hasKey) return "client_pair_incomplete";
  return null;
}

function clientPemInput(state: InstanceFormState, pem: string): string | undefined {
  if (state.removeClientCert) return "";
  const trimmed = pem.trim();
  return trimmed ? trimmed : undefined;
}

export function buildInstanceInput(state: InstanceFormState): ArgoCdInstanceInput {
  const headers = state.headers
    .filter((header) => header.name.trim().length > 0)
    .map((header) => ({
      name: header.name.trim(),
      value: header.stored && header.value === "" ? undefined : header.value,
    }));
  const username = state.authMethod === "password" ? state.username.trim() || null : null;
  const caPem = state.caPem.trim();
  return {
    id: state.id,
    url: state.url.trim().replace(/\/+$/, ""),
    displayName: state.displayName.trim(),
    authMethod: state.authMethod,
    username,
    tlsSkipVerify: state.tlsSkipVerify,
    caPem: caPem ? caPem : null,
    headers,
    clientCertPem: clientPemInput(state, state.clientCertPem),
    clientKeyPem: clientPemInput(state, state.clientKeyPem),
    rememberPassword: state.authMethod === "password" && state.rememberPassword,
  };
}

/** Re-save an existing instance unchanged except for `patch` (stored secrets kept). */
export function instanceToInput(
  instance: ArgoCdInstance,
  patch: Partial<Pick<ArgoCdInstanceInput, "tlsSkipVerify">>,
): ArgoCdInstanceInput {
  return {
    id: instance.id,
    url: instance.url,
    displayName: instance.displayName,
    authMethod: instance.authMethod,
    username: instance.username,
    tlsSkipVerify: instance.tlsSkipVerify,
    caPem: instance.caPem,
    headers: instance.headerNames.map((name) => ({ name })),
    rememberPassword: instance.rememberPassword,
    ...patch,
  };
}
