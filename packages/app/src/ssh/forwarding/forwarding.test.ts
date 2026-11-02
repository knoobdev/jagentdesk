import { describe, expect, it } from "vitest";
import type { ForwardingRule, ForwardingState } from "@jagentdesk/protocol/ssh/forwarding-schemas";
import type { SshModuleTransport } from "../module-rpc";
import { createForwardingApi } from "./api";
import {
  applyForwardState,
  describeRule,
  emptyRuleForm,
  exposesToNetwork,
  parseRuleForm,
  ruleToForm,
} from "./model";
import { createForwardingStore } from "./store";

const rule: ForwardingRule = {
  id: "fwd_a1b2c3",
  label: "db",
  kind: "local",
  serverId: "srv_a1b2c3",
  bindAddress: "127.0.0.1",
  bindPort: 15432,
  destHost: "db",
  destPort: 5432,
  createdAtMs: 1,
  updatedAtMs: 1,
};

function state(overrides: Partial<ForwardingState>): ForwardingState {
  return { ruleId: rule.id, status: "active", activeConnections: 0, changedAtMs: 1, ...overrides };
}

describe("rule form", () => {
  it("parses a local rule with the loopback default", () => {
    const form = { ...emptyRuleForm("local", "srv_a1b2c3"), label: "db", bindPort: "15432" };
    expect(parseRuleForm({ ...form, destHost: "db", destPort: "5432" })).toEqual({
      ok: true,
      input: {
        label: "db",
        kind: "local",
        serverId: "srv_a1b2c3",
        bindAddress: "127.0.0.1",
        bindPort: 15432,
        destHost: "db",
        destPort: 5432,
      },
    });
  });

  it("reports each missing or invalid field", () => {
    const form = { ...emptyRuleForm("local", ""), bindPort: "70000" };
    expect(parseRuleForm(form)).toEqual({
      ok: false,
      errors: {
        label: "required",
        serverId: "required",
        bindPort: "port",
        destHost: "required",
        destPort: "required",
      },
    });
  });

  it("lets a remote rule bind port 0 and a dynamic rule skip the destination", () => {
    const remote = {
      ...emptyRuleForm("remote", "srv_a1b2c3"),
      label: "callback",
      bindPort: "0",
      destPort: "3000",
    };
    expect(parseRuleForm(remote)).toMatchObject({
      ok: true,
      input: { bindPort: 0, destHost: "127.0.0.1" },
    });
    const dynamic = { ...emptyRuleForm("dynamic", "srv_a1b2c3"), label: "socks", bindPort: "1080" };
    expect(parseRuleForm(dynamic)).toEqual({
      ok: true,
      input: {
        label: "socks",
        kind: "dynamic",
        serverId: "srv_a1b2c3",
        bindAddress: "127.0.0.1",
        bindPort: 1080,
      },
    });
  });

  it("duplicates a rule as a new one", () => {
    expect(ruleToForm(rule, { duplicateLabel: "db copy" })).toEqual({
      label: "db copy",
      kind: "local",
      serverId: "srv_a1b2c3",
      bindAddress: "127.0.0.1",
      bindPort: "15432",
      destHost: "db",
      destPort: "5432",
    });
    expect(ruleToForm(rule, {}).id).toBe("fwd_a1b2c3");
  });

  it("describes the ends and flags network-exposed binds", () => {
    expect(describeRule(rule)).toEqual({ from: "127.0.0.1:15432", to: "db:5432" });
    expect(describeRule({ ...rule, kind: "dynamic", bindAddress: "::1" })).toEqual({
      from: "[::1]:15432",
      to: "SOCKS5",
    });
    expect(exposesToNetwork(rule)).toBe(false);
    expect(exposesToNetwork({ bindAddress: "0.0.0.0" })).toBe(true);
  });

  it("keeps the newest state per rule", () => {
    const states = { [rule.id]: state({ changedAtMs: 5 }) };
    expect(applyForwardState(states, state({ changedAtMs: 4, status: "stopped" }))).toBe(states);
    expect(
      applyForwardState(states, state({ changedAtMs: 6, status: "error" }))[rule.id].status,
    ).toBe("error");
  });
});

describe("forwarding store", () => {
  it("loads rules and applies state pushes from other clients", async () => {
    const handlers = new Set<(message: unknown) => void>();
    const transport: SshModuleTransport = {
      async request(message) {
        expect(message.type).toBe("ssh.forward.list.request");
        return {
          type: "ssh.forward.list.response",
          payload: {
            requestId: "req",
            error: null,
            rules: [rule],
            states: [state({ status: "stopped", changedAtMs: 1 })],
          },
        };
      },
      subscribe(type, handler) {
        expect(type).toBe("ssh.forward.state");
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
    };
    const store = createForwardingStore(createForwardingApi(transport));
    const ready = new Promise<void>((resolve) =>
      store.subscribe(() => {
        if (store.getSnapshot().status === "ready") resolve();
      }),
    );
    const stop = store.start();
    await ready;
    for (const handler of handlers) {
      handler({
        type: "ssh.forward.state",
        state: state({
          status: "error",
          changedAtMs: 2,
          error: { code: "port_in_use", message: "busy" },
        }),
      });
    }

    expect(store.getSnapshot()).toEqual({
      status: "ready",
      error: null,
      rules: [rule],
      states: {
        [rule.id]: state({
          status: "error",
          changedAtMs: 2,
          error: { code: "port_in_use", message: "busy" },
        }),
      },
    });
    stop();
  });
});
