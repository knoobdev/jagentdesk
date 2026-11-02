import { describe, expect, it } from "vitest";
import type { SshGroup, SshIdentity, SshServer } from "@jagentdesk/protocol/ssh/rpc-schemas";
import { resolveSshConfig, validateJumpChain } from "./config-resolution.js";

function maps(groups: SshGroup[], identities: SshIdentity[] = []) {
  return {
    groups: new Map(groups.map((g) => [g.id, g])),
    identities: new Map(identities.map((i) => [i.id, i])),
  };
}

const root: SshGroup = {
  id: "grp_root",
  label: "Production",
  username: "deploy",
  port: 2200,
  env: { JAD_STAGE: "prod" },
  jumpChain: ["srv_bastion"],
  proxy: { type: "socks5", host: "<proxy-host>", port: 1080 },
  theme: "red",
};
const child: SshGroup = { id: "grp_child", label: "Web", parentId: "grp_root", port: 2201 };

describe("resolveSshConfig (spec 25.2 group inheritance)", () => {
  it("takes each field from the nearest node that sets it", () => {
    const server: SshServer = {
      id: "srv_a",
      label: "web-1",
      address: "<host-a>",
      groupId: "grp_child",
    };
    const config = resolveSshConfig({ server, ...maps([root, child]) });
    expect(config).toEqual({
      serverId: "srv_a",
      host: "<host-a>",
      port: 2201,
      protocol: "ssh",
      username: "deploy",
      authMethods: ["password", "key", "keyboard-interactive"],
      jumpChain: ["srv_bastion"],
      proxy: { type: "socks5", host: "<proxy-host>", port: 1080 },
      proxyOwnerId: "grp_root",
      env: { JAD_STAGE: "prod" },
      agentForwarding: false,
      keepaliveIntervalS: 30,
      autoReconnect: true,
      theme: "red",
    });
  });

  it("treats empty values on the server as unset and keeps walking", () => {
    const server: SshServer = {
      id: "srv_a",
      label: "web-1",
      address: "<host-a>",
      groupId: "grp_child",
      username: "",
      jumpChain: [],
      env: {},
    };
    const config = resolveSshConfig({ server, ...maps([root, child]) });
    expect([config.username, config.jumpChain, config.env]).toEqual([
      "deploy",
      ["srv_bastion"],
      { JAD_STAGE: "prod" },
    ]);
  });

  it("server values override groups; identity supplies username and key last", () => {
    const identity: SshIdentity = { id: "idn_1", label: "ops", username: "ops", keyId: "key_1" };
    const server: SshServer = {
      id: "srv_b",
      label: "db",
      address: "<host-b>",
      identityId: "idn_1",
      keepaliveIntervalS: 0,
      autoReconnect: false,
    };
    const config = resolveSshConfig({ server, ...maps([], [identity]) });
    expect({
      username: config.username,
      keyId: config.keyId,
      port: config.port,
      keepaliveIntervalS: config.keepaliveIntervalS,
      autoReconnect: config.autoReconnect,
    }).toEqual({
      username: "ops",
      keyId: "key_1",
      port: 22,
      keepaliveIntervalS: 0,
      autoReconnect: false,
    });
  });

  it("stops at a group cycle instead of looping", () => {
    const a: SshGroup = { id: "grp_a", label: "a", parentId: "grp_b", username: "from-a" };
    const b: SshGroup = { id: "grp_b", label: "b", parentId: "grp_a" };
    const server: SshServer = { id: "srv_c", label: "c", address: "<host-c>", groupId: "grp_b" };
    expect(resolveSshConfig({ server, ...maps([a, b]) }).username).toBe("from-a");
  });

  it("telnet servers default to port 23", () => {
    const server: SshServer = {
      id: "srv_t",
      label: "switch",
      address: "<host-t>",
      protocol: "telnet",
    };
    expect(resolveSshConfig({ server, ...maps([]) }).port).toBe(23);
  });
});

describe("validateJumpChain", () => {
  const exists = (id: string) => id !== "srv_missing";
  it("accepts a chain of distinct existing servers", () => {
    expect(validateJumpChain("srv_t", ["srv_a", "srv_b"], exists)).toBeNull();
  });
  it("rejects the target inside its own chain, repeats and unknown hops", () => {
    expect([
      validateJumpChain("srv_t", ["srv_a", "srv_t"], exists),
      validateJumpChain("srv_t", ["srv_a", "srv_a"], exists),
      validateJumpChain("srv_t", ["srv_missing"], exists),
    ]).toEqual([
      "Jump chain repeats server srv_t.",
      "Jump chain repeats server srv_a.",
      "Jump host srv_missing does not exist.",
    ]);
  });
});
