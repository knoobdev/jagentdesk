import {
  isLoopbackBindAddress,
  type ForwardingKind,
  type ForwardingRule,
  type ForwardingRuleInput,
  type ForwardingState,
} from "@jagentdesk/protocol/ssh/forwarding-schemas";

export interface RuleForm {
  id?: string;
  label: string;
  kind: ForwardingKind;
  serverId: string;
  bindAddress: string;
  bindPort: string;
  destHost: string;
  destPort: string;
}

export type RuleFormField = "label" | "serverId" | "bindPort" | "destHost" | "destPort";
export type RuleFormError = "required" | "port";
export type RuleFormErrors = Partial<Record<RuleFormField, RuleFormError>>;

export type ParsedRuleForm =
  | { ok: true; input: ForwardingRuleInput }
  | { ok: false; errors: RuleFormErrors };

export const DEFAULT_BIND_ADDRESS = "127.0.0.1";

export function emptyRuleForm(kind: ForwardingKind, serverId: string): RuleForm {
  return {
    label: "",
    kind,
    serverId,
    bindAddress: DEFAULT_BIND_ADDRESS,
    bindPort: "",
    destHost: kind === "remote" ? "127.0.0.1" : "",
    destPort: "",
  };
}

/** Form for editing a rule, or for a duplicate when `duplicate` (no id, "copy" label). */
export function ruleToForm(rule: ForwardingRule, options: { duplicateLabel?: string }): RuleForm {
  const form: RuleForm = {
    label: options.duplicateLabel ?? rule.label,
    kind: rule.kind,
    serverId: rule.serverId,
    bindAddress: rule.bindAddress,
    bindPort: String(rule.bindPort),
    destHost: rule.destHost ?? "",
    destPort: rule.destPort ? String(rule.destPort) : "",
  };
  if (!options.duplicateLabel) form.id = rule.id;
  return form;
}

function parsePort(value: string, allowZero: boolean): number | null {
  if (!/^\d{1,5}$/.test(value.trim())) return null;
  const port = Number(value.trim());
  const min = allowZero ? 0 : 1;
  return port >= min && port <= 65535 ? port : null;
}

export function parseRuleForm(form: RuleForm): ParsedRuleForm {
  const errors: RuleFormErrors = {};
  const label = form.label.trim();
  if (!label) errors.label = "required";
  if (!form.serverId) errors.serverId = "required";
  // The server picks a free port for a remote rule bound to port 0, like `ssh -R 0:…`.
  const bindPort = parsePort(form.bindPort, form.kind === "remote");
  if (bindPort === null) errors.bindPort = form.bindPort.trim() ? "port" : "required";
  let destHost: string | undefined;
  let destPort: number | undefined;
  if (form.kind !== "dynamic") {
    destHost = form.destHost.trim();
    if (!destHost) errors.destHost = "required";
    const parsed = parsePort(form.destPort, false);
    if (parsed === null) errors.destPort = form.destPort.trim() ? "port" : "required";
    else destPort = parsed;
  }
  if (Object.keys(errors).length > 0 || bindPort === null) return { ok: false, errors };
  const input: ForwardingRuleInput = {
    label,
    kind: form.kind,
    serverId: form.serverId,
    bindAddress: form.bindAddress.trim() || DEFAULT_BIND_ADDRESS,
    bindPort,
  };
  if (form.id) input.id = form.id;
  if (destHost && destPort) {
    input.destHost = destHost;
    input.destPort = destPort;
  }
  return { ok: true, input };
}

/** Binding off loopback exposes the port to the network; the UI confirms first (spec 25.6). */
export function exposesToNetwork(rule: Pick<ForwardingRule, "bindAddress">): boolean {
  return !isLoopbackBindAddress(rule.bindAddress);
}

function hostPort(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

/** The two ends of a rule as `ssh -L/-R/-D` users read them. */
export function describeRule(
  rule: ForwardingRule,
  boundPort?: number,
): { from: string; to: string } {
  const port = boundPort ?? rule.bindPort;
  const listen = hostPort(rule.bindAddress, port);
  if (rule.kind === "dynamic") return { from: listen, to: "SOCKS5" };
  return { from: listen, to: hostPort(rule.destHost ?? "", rule.destPort ?? 0) };
}

export function applyForwardState(
  states: Record<string, ForwardingState>,
  state: ForwardingState,
): Record<string, ForwardingState> {
  const previous = states[state.ruleId];
  if (previous && previous.changedAtMs > state.changedAtMs) return states;
  return { ...states, [state.ruleId]: state };
}
