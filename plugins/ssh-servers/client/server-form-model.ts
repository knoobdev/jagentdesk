import type {
  SshAuthMethod,
  SshGroup,
  SshProxy,
  SshServer,
} from "@jagentdesk/client/internal/daemon-client";
import type { SshTerminalAppearance } from "@jagentdesk/protocol/ssh/snippets-schemas";

export const SSH_AUTH_METHODS: readonly SshAuthMethod[] = [
  "password",
  "key",
  "keyboard-interactive",
  "agent",
];

export const SSH_AUTH_METHOD_LABELS: Record<SshAuthMethod, string> = {
  password: "Password",
  key: "Private key",
  "keyboard-interactive": "Keyboard interactive",
  agent: "Agent",
};

export const DEFAULT_SSH_PORT = 22;

export interface SshServerFormState {
  label: string;
  address: string;
  port: string;
  errors: {
    label: string | null;
    address: string | null;
    port: string | null;
    env: string | null;
    proxy: string | null;
    keepalive: string | null;
  };
  disclosure: "basic" | "auth" | "advanced" | "remoteExec" | "appearance";
  groupId: string;
  identityId: string;
  username: string;
  tags: string[];
  tagDraft: string;
  authMethods: SshAuthMethod[];
  passwordDraft: string;
  hasStoredPassword: boolean;
  clearRequested: boolean;
  // Advanced (spec 25.2 / 25.3, inherited from the group when left empty)
  jumpChain: string[];
  proxyType: "" | SshProxy["type"];
  proxyHost: string;
  proxyPort: string;
  proxyUsername: string;
  proxyPasswordDraft: string;
  hasStoredProxyPassword: boolean;
  envText: string;
  startupSnippetId: string;
  agentForwarding: "inherit" | "on" | "off";
  autoReconnect: "inherit" | "on" | "off";
  keepaliveS: string;
  /** spec 25.10: detect the server environment after each connect (server-only, default on). */
  detectEnvironment: boolean;
  // Remote execution (spec 33.2 / 33.3, server-only): how the daemon reaches the host and
  // whether the server accepts remote job targets.
  via: "direct" | "tailnet";
  remoteExecEnabled: boolean;
  remoteWorkRoot: string;
  // Terminal theme + font size set on this server; unset fields inherit from its groups (25.4).
  appearance: SshTerminalAppearance;
  formError: string | null;
  canSubmit: boolean;
}

/** Exactly the options bag `client.sshServersSave` takes. */
export interface SshServerSavePayload {
  server: SshServer;
  /** undefined keeps the stored secret, "" deletes it, non-empty replaces it. */
  password?: string;
  proxyPassword?: string;
}

export interface SshServerFormModel {
  getState: () => SshServerFormState;
  subscribe: (listener: () => void) => () => void;
  close: () => void;
  buildSavePayload: () => SshServerSavePayload;
  setLabel: (value: string) => void;
  setAddress: (value: string) => void;
  setPort: (value: string) => void;
  setDisclosure: (disclosure: SshServerFormState["disclosure"]) => void;
  setAdvanced: (patch: Partial<SshServerAdvancedFields>) => void;
  setAppearance: (appearance: SshTerminalAppearance) => void;
  setVia: (via: SshServerFormState["via"]) => void;
  setRemoteExecEnabled: (enabled: boolean) => void;
  setRemoteWorkRoot: (value: string) => void;
  toggleJumpHost: (serverId: string) => void;
  setGroup: (groupId: string) => void;
  setIdentity: (identityId: string) => void;
  setUsername: (username: string) => void;
  setTagDraft: (value: string) => void;
  commitTagDraft: () => void;
  removeTag: (tag: string) => void;
  toggleAuthMethod: (method: SshAuthMethod) => void;
  moveAuthMethod: (index: number, direction: -1 | 1) => void;
  setPasswordDraft: (value: string) => void;
  requestClearPassword: () => void;
  setSubmitError: (message: string | null) => void;
}

export type SshServerAdvancedFields = Pick<
  SshServerFormState,
  | "proxyType"
  | "proxyHost"
  | "proxyPort"
  | "proxyUsername"
  | "proxyPasswordDraft"
  | "envText"
  | "startupSnippetId"
  | "agentForwarding"
  | "autoReconnect"
  | "keepaliveS"
  | "detectEnvironment"
>;

/** `KEY=VALUE` per line → record; returns the first invalid line as an error. */
export function parseEnvText(text: string): { env: Record<string, string>; error: string | null } {
  const env: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    const name = eq > 0 ? line.slice(0, eq).trim() : "";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      return { env: {}, error: `Use NAME=value per line (bad line: ${line})` };
    }
    env[name] = line.slice(eq + 1);
  }
  return { env, error: null };
}

export function formatEnvText(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {})
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
}

function triState(value: boolean | undefined): "inherit" | "on" | "off" {
  if (value === undefined) return "inherit";
  return value ? "on" : "off";
}

function fromTriState(value: "inherit" | "on" | "off"): boolean | undefined {
  if (value === "inherit") return undefined;
  return value === "on";
}

function portError(value: string): string | null {
  if (!value.trim()) return null;
  const port = Number.parseInt(value, 10);
  return !Number.isFinite(port) || port < 1 || port > 65535
    ? "Port must be between 1 and 65535"
    : null;
}

export interface SshServerFormSnapshot {
  server: SshServer | null;
  defaultGroupId: string | null;
}

function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase();
}

function deriveErrors(state: SshServerFormState): SshServerFormState["errors"] {
  const keepalive = Number.parseInt(state.keepaliveS, 10);
  let proxy: string | null = null;
  if (state.proxyType && !state.proxyHost.trim()) proxy = "Proxy host is required";
  else if (state.proxyType) proxy = portError(state.proxyPort || "x");
  // The daemon rejects the combination on save (spec 33.2), so surface it before submit.
  if (state.proxyType && state.via === "tailnet") {
    proxy = "A tailnet route cannot be combined with a proxy";
  }
  return {
    label: state.label.trim() ? null : "Label is required",
    address: state.address.trim() ? null : "Address is required",
    port: portError(state.port),
    env: parseEnvText(state.envText).error,
    proxy,
    keepalive:
      state.keepaliveS.trim() && (!Number.isFinite(keepalive) || keepalive < 0 || keepalive > 3600)
        ? "Keepalive must be 0–3600 seconds"
        : null,
  };
}

function withDerived(next: SshServerFormState): SshServerFormState {
  const errors = deriveErrors(next);
  return {
    ...next,
    errors,
    canSubmit: Object.values(errors).every((error) => error === null),
  };
}

function optionalString(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function optionalInt(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalList<T>(values: readonly T[]): T[] | undefined {
  return values.length > 0 ? [...values] : undefined;
}

type BasicFields = Pick<
  SshServerFormState,
  | "label"
  | "address"
  | "port"
  | "groupId"
  | "identityId"
  | "username"
  | "tags"
  | "authMethods"
  | "hasStoredPassword"
>;

function initialBasicFields(server: SshServer | null, defaultGroupId: string | null): BasicFields {
  return {
    label: server?.label ?? "",
    address: server?.address ?? "",
    port: server?.port === undefined ? "" : String(server.port),
    groupId: server?.groupId ?? defaultGroupId ?? "",
    identityId: server?.identityId ?? "",
    username: server?.username ?? "",
    tags: server?.tags ? [...server.tags] : [],
    authMethods: server?.authMethods ? [...server.authMethods] : [],
    hasStoredPassword: server?.hasPassword === true,
  };
}

type AdvancedInitialFields = Omit<SshServerAdvancedFields, "proxyPasswordDraft"> &
  Pick<SshServerFormState, "jumpChain" | "hasStoredProxyPassword" | "appearance"> &
  Pick<SshServerFormState, "via" | "remoteExecEnabled" | "remoteWorkRoot">;

function initialRemoteExecFields(server: SshServer | null) {
  return {
    via: server?.via ?? "direct",
    remoteExecEnabled: server?.remoteExec?.enabled === true,
    remoteWorkRoot: server?.remoteExec?.workRoot ?? "",
  };
}

function initialAdvancedFields(server: SshServer | null): AdvancedInitialFields {
  const proxy = server?.proxy;
  return {
    jumpChain: server?.jumpChain ? [...server.jumpChain] : [],
    proxyType: proxy?.type ?? "",
    proxyHost: proxy?.host ?? "",
    proxyPort: proxy ? String(proxy.port) : "",
    proxyUsername: proxy?.username ?? "",
    hasStoredProxyPassword: proxy?.hasPassword === true,
    envText: formatEnvText(server?.env),
    startupSnippetId: server?.startupSnippetId ?? "",
    agentForwarding: triState(server?.agentForwarding),
    autoReconnect: triState(server?.autoReconnect),
    keepaliveS: server?.keepaliveIntervalS === undefined ? "" : String(server.keepaliveIntervalS),
    detectEnvironment: server?.detectEnvironment !== false,
    ...initialRemoteExecFields(server),
    appearance: initialAppearance(server),
  };
}

function initialAppearance(server: SshServer | null): SshTerminalAppearance {
  return { theme: server?.theme, fontSize: server?.fontSize };
}

function buildProxy(state: SshServerFormState): SshProxy | undefined {
  if (!state.proxyType) return undefined;
  const username = optionalString(state.proxyUsername);
  return {
    type: state.proxyType,
    host: state.proxyHost.trim(),
    port: Number.parseInt(state.proxyPort, 10),
    ...(username ? { username } : {}),
  };
}

/** The DTO to save. Fields the form does not edit (forwarding rules, …) survive. */
function buildServerDto(server: SshServer | null, state: SshServerFormState): SshServer {
  const env = parseEnvText(state.envText).env;
  const { hasPassword: _wireOnly, ...kept } = server ?? { id: "", label: "", address: "" };
  return {
    ...kept,
    id: server?.id ?? "",
    label: state.label.trim(),
    address: state.address.trim(),
    port: optionalInt(state.port),
    groupId: state.groupId || undefined,
    identityId: state.identityId || undefined,
    username: optionalString(state.username),
    tags: [...state.tags],
    authMethods: optionalList(state.authMethods),
    jumpChain: optionalList(state.jumpChain),
    proxy: buildProxy(state),
    env: Object.keys(env).length > 0 ? env : undefined,
    startupSnippetId: optionalString(state.startupSnippetId),
    agentForwarding: fromTriState(state.agentForwarding),
    autoReconnect: fromTriState(state.autoReconnect),
    keepaliveIntervalS: optionalInt(state.keepaliveS),
    detectEnvironment: state.detectEnvironment ? undefined : false,
    // "direct" is the wire default, so it is omitted on save (spec 33.2).
    via: state.via === "tailnet" ? "tailnet" : undefined,
    remoteExec: buildRemoteExec(state),
    theme: state.appearance.theme,
    fontSize: state.appearance.fontSize,
  };
}

/** spec 33.3: `remoteExec` is absent while the switch is off; an empty work folder is omitted. */
function buildRemoteExec(state: SshServerFormState): SshServer["remoteExec"] {
  if (!state.remoteExecEnabled) return undefined;
  const workRoot = optionalString(state.remoteWorkRoot);
  return workRoot ? { enabled: true, workRoot } : { enabled: true };
}

/**
 * SSH server create/edit form. Password semantics (spec 25.16 S1.2): the draft
 * never carries a stored secret, an untouched password field is omitted from the
 * save payload, and `""` reaches the daemon only after an explicit clear request.
 */
export function openSshServerFormModel(snapshot: SshServerFormSnapshot): SshServerFormModel {
  const server = snapshot.server;

  const listeners = new Set<() => void>();
  let closed = false;

  let state: SshServerFormState = withDerived({
    ...initialBasicFields(server, snapshot.defaultGroupId),
    ...initialAdvancedFields(server),
    errors: { label: null, address: null, port: null, env: null, proxy: null, keepalive: null },
    disclosure: "basic",
    tagDraft: "",
    passwordDraft: "",
    clearRequested: false,
    proxyPasswordDraft: "",
    formError: null,
    canSubmit: false,
  });

  function publish(next: SshServerFormState) {
    state = withDerived(next);
    if (closed) return;
    for (const listener of Array.from(listeners)) listener();
  }

  function set(patch: Partial<SshServerFormState>) {
    publish({ ...state, ...patch });
  }

  function buildSavePayload(): SshServerSavePayload {
    const payload: SshServerSavePayload = { server: buildServerDto(server, state) };
    if (state.passwordDraft) payload.password = state.passwordDraft;
    else if (server && state.clearRequested) payload.password = "";
    if (state.proxyPasswordDraft) payload.proxyPassword = state.proxyPasswordDraft;
    else if (!state.proxyType && server?.proxy?.hasPassword) payload.proxyPassword = "";
    return payload;
  }

  return {
    getState: () => state,
    subscribe(listener) {
      if (closed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      closed = true;
      listeners.clear();
    },
    buildSavePayload,
    setLabel: (value) => set({ label: value }),
    setAddress: (value) => set({ address: value }),
    setPort: (value) => set({ port: value }),
    setDisclosure: (disclosure) => set({ disclosure }),
    setAdvanced: (patch) => set(patch),
    setAppearance: (appearance) => set({ appearance }),
    setVia: (via) => set({ via }),
    setRemoteExecEnabled: (remoteExecEnabled) => set({ remoteExecEnabled }),
    setRemoteWorkRoot: (remoteWorkRoot) => set({ remoteWorkRoot }),
    toggleJumpHost(serverId) {
      const chain = state.jumpChain.includes(serverId)
        ? state.jumpChain.filter((id) => id !== serverId)
        : [...state.jumpChain, serverId];
      set({ jumpChain: chain });
    },
    setGroup: (groupId) => set({ groupId }),
    setIdentity: (identityId) => set({ identityId }),
    setUsername: (username) => set({ username }),
    setTagDraft: (value) => set({ tagDraft: value }),
    commitTagDraft() {
      const tag = normalizeTag(state.tagDraft);
      if (!tag || state.tags.includes(tag)) {
        set({ tagDraft: "" });
        return;
      }
      set({ tags: [...state.tags, tag], tagDraft: "" });
    },
    removeTag(tag) {
      set({ tags: state.tags.filter((t) => t !== tag) });
    },
    toggleAuthMethod(method) {
      const order = state.authMethods.includes(method)
        ? state.authMethods.filter((m) => m !== method)
        : [...state.authMethods, method];
      set({ authMethods: order });
    },
    moveAuthMethod(index, direction) {
      const to = index + direction;
      if (
        index < 0 ||
        to < 0 ||
        index >= state.authMethods.length ||
        to >= state.authMethods.length
      )
        return;
      const order = [...state.authMethods];
      const [item] = order.splice(index, 1);
      order.splice(to, 0, item);
      set({ authMethods: order });
    },
    setPasswordDraft: (value) => set({ passwordDraft: value, clearRequested: false }),
    requestClearPassword: () =>
      set({ clearRequested: true, passwordDraft: "", hasStoredPassword: false }),
    setSubmitError: (message) => set({ formError: message }),
  };
}

/** Path labels for the group select, indented by tree depth. */
export function buildGroupOptions(
  groups: readonly SshGroup[],
  selectedId: string,
): Array<{ value: string; label: string; selected: boolean }> {
  const byParent = new Map<string, SshGroup[]>();
  for (const group of groups) {
    const key = group.parentId ?? "";
    const list = byParent.get(key) ?? [];
    list.push(group);
    byParent.set(key, list);
  }
  const options: Array<{ value: string; label: string; selected: boolean }> = [];
  const seen = new Set<string>();
  const walk = (parentId: string, depth: number) => {
    const children = [...(byParent.get(parentId) ?? [])].sort((a, b) =>
      a.label.localeCompare(b.label),
    );
    for (const group of children) {
      if (seen.has(group.id)) continue;
      seen.add(group.id);
      options.push({
        value: group.id,
        label: `${"  ".repeat(depth)}${group.label}`,
        selected: group.id === selectedId,
      });
      walk(group.id, depth + 1);
    }
  };
  walk("", 0);
  for (const group of groups) {
    if (!seen.has(group.id)) {
      options.push({ value: group.id, label: group.label, selected: group.id === selectedId });
    }
  }
  return options;
}
