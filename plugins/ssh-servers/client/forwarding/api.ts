import {
  SshForwardDeleteResponseSchema,
  SshForwardListResponseSchema,
  SshForwardSaveResponseSchema,
  SshForwardStartResponseSchema,
  SshForwardStateSchema,
  SshForwardStopResponseSchema,
  type ForwardingRule,
  type ForwardingRuleInput,
  type ForwardingState,
} from "@jagentdesk/protocol/ssh/forwarding-schemas";
import {
  SshModuleRpcError,
  callSshModule,
  subscribeSshModule,
  type SshModuleTransport,
} from "../module-rpc";

export interface ForwardingListing {
  rules: ForwardingRule[];
  states: ForwardingState[];
}

export interface ForwardingApi {
  list(): Promise<ForwardingListing>;
  save(rule: ForwardingRuleInput): Promise<ForwardingRule>;
  remove(id: string): Promise<void>;
  /** Resolves with the final state; a failed start (e.g. port_in_use) rejects. */
  start(id: string): Promise<ForwardingState>;
  stop(id: string): Promise<ForwardingState>;
  subscribeStates(handler: (state: ForwardingState) => void): () => void;
}

function required<T>(value: T | null, what: string): T {
  if (value === null) throw new SshModuleRpcError("failed", `The daemon returned no ${what}`);
  return value;
}

export function createForwardingApi(transport: SshModuleTransport): ForwardingApi {
  return {
    async list() {
      const payload = await callSshModule(transport, SshForwardListResponseSchema, {
        type: "ssh.forward.list.request",
      });
      return { rules: payload.rules, states: payload.states };
    },
    async save(rule) {
      const payload = await callSshModule(transport, SshForwardSaveResponseSchema, {
        type: "ssh.forward.save.request",
        rule,
      });
      return required(payload.rule, "rule");
    },
    async remove(id) {
      await callSshModule(transport, SshForwardDeleteResponseSchema, {
        type: "ssh.forward.delete.request",
        id,
      });
    },
    async start(id) {
      const payload = await callSshModule(transport, SshForwardStartResponseSchema, {
        type: "ssh.forward.start.request",
        id,
      });
      return required(payload.state, "state");
    },
    async stop(id) {
      const payload = await callSshModule(transport, SshForwardStopResponseSchema, {
        type: "ssh.forward.stop.request",
        id,
      });
      return required(payload.state, "state");
    },
    subscribeStates(handler) {
      return subscribeSshModule(transport, "ssh.forward.state", SshForwardStateSchema, (event) =>
        handler(event.state),
      );
    },
  };
}
