import { describe, expect, it } from "vitest";
import type { SshServer } from "@jagentdesk/client/internal/daemon-client";
import {
  buildGroupOptions,
  openSshServerFormModel,
  type SshServerFormSnapshot,
} from "./server-form-model";

const stored: SshServer = {
  id: "srv-1",
  label: "Prod box",
  address: "<hostname>",
  port: 2222,
  username: "root",
  authMethods: ["key", "password"],
  tags: ["prod"],
  hasPassword: true,
};

const emptySnapshot: SshServerFormSnapshot = { server: null, defaultGroupId: null };

describe("openSshServerFormModel", () => {
  it("starts invalid until label and address are set", () => {
    const model = openSshServerFormModel(emptySnapshot);
    expect(model.getState().canSubmit).toBe(false);
    expect(model.getState().errors.label).toBeTruthy();
    expect(model.getState().errors.address).toBeTruthy();

    model.setLabel("Box");
    model.setAddress("box.local");
    expect(model.getState().canSubmit).toBe(true);
    expect(model.getState().errors.label).toBeNull();
  });

  it("validates the port range", () => {
    const model = openSshServerFormModel(emptySnapshot);
    model.setLabel("Box");
    model.setAddress("box.local");

    model.setPort("0");
    expect(model.getState().canSubmit).toBe(false);
    model.setPort("65536");
    expect(model.getState().canSubmit).toBe(false);
    model.setPort("22");
    expect(model.getState().canSubmit).toBe(true);
  });

  it("notifies subscribers on change and stops after close", () => {
    const model = openSshServerFormModel(emptySnapshot);
    let notifications = 0;
    const unsubscribe = model.subscribe(() => {
      notifications += 1;
    });
    model.setLabel("Box");
    expect(notifications).toBe(1);
    unsubscribe();
    model.setLabel("Box 2");
    expect(notifications).toBe(1);
    model.close();
    model.setLabel("Box 3");
    expect(notifications).toBe(1);
  });

  it("commits trimmed lowercase tags and dedupes", () => {
    const model = openSshServerFormModel(emptySnapshot);
    model.setTagDraft("web");
    model.commitTagDraft();
    model.setTagDraft("WEB ");
    model.commitTagDraft();
    model.setTagDraft("ssh ");
    model.commitTagDraft();

    expect(model.getState().tags).toEqual(["web", "ssh"]);
    expect(model.getState().tagDraft).toBe("");
  });

  it("auth methods start empty and support toggle + reorder", () => {
    const model = openSshServerFormModel(emptySnapshot);
    expect(model.getState().authMethods).toEqual([]);

    model.toggleAuthMethod("password");
    model.toggleAuthMethod("agent");
    expect(model.getState().authMethods).toEqual(["password", "agent"]);
    model.moveAuthMethod(0, 1);
    expect(model.getState().authMethods).toEqual(["agent", "password"]);
    model.toggleAuthMethod("agent");
    expect(model.getState().authMethods).toEqual(["password"]);
  });

  it("builds a create payload without an id and with the typed password", () => {
    const model = openSshServerFormModel(emptySnapshot);
    model.setLabel("Box");
    model.setAddress("box.local");
    model.setPasswordDraft("hunter2");

    const payload = model.buildSavePayload();
    expect(payload.server.id).toBe("");
    expect(payload.server.label).toBe("Box");
    // A blank port is not saved, so the group's port (or 22) applies.
    expect(payload.server.port).toBeUndefined();
    expect(payload.password).toBe("hunter2");
  });

  it("builds the advanced connection fields and validates env lines", () => {
    const model = openSshServerFormModel(emptySnapshot);
    model.setLabel("Box");
    model.setAddress("<hostname>");
    model.toggleJumpHost("srv_bastion");
    model.toggleJumpHost("srv_inner");
    model.setAdvanced({
      proxyType: "socks5",
      proxyHost: "<proxy-host>",
      proxyPort: "1080",
      proxyUsername: "u",
      proxyPasswordDraft: "proxy-secret",
      envText: "JAD_A=1\nJAD_B=two words",
      agentForwarding: "on",
      autoReconnect: "off",
      keepaliveS: "15",
    });
    const payload = model.buildSavePayload();
    expect(payload).toEqual({
      server: {
        id: "",
        label: "Box",
        address: "<hostname>",
        port: undefined,
        groupId: undefined,
        identityId: undefined,
        username: undefined,
        tags: [],
        authMethods: undefined,
        jumpChain: ["srv_bastion", "srv_inner"],
        proxy: { type: "socks5", host: "<proxy-host>", port: 1080, username: "u" },
        env: { JAD_A: "1", JAD_B: "two words" },
        startupSnippetId: undefined,
        agentForwarding: true,
        autoReconnect: false,
        keepaliveIntervalS: 15,
      },
      proxyPassword: "proxy-secret",
    });
    model.setAdvanced({ envText: "not a pair" });
    expect([model.getState().errors.env, model.getState().canSubmit]).toEqual([
      "Use NAME=value per line (bad line: not a pair)",
      false,
    ]);
  });

  it("omits password when untouched, so a stored secret is never re-sent", () => {
    const model = openSshServerFormModel({ server: stored, defaultGroupId: null });
    expect(model.getState().hasStoredPassword).toBe(true);
    expect(model.getState().passwordDraft).toBe("");

    const payload = model.buildSavePayload();
    expect(payload.server.id).toBe("srv-1");
    expect("password" in payload).toBe(false);
  });

  it("sends an empty password only after an explicit clear request", () => {
    const model = openSshServerFormModel({ server: stored, defaultGroupId: null });
    model.requestClearPassword();
    expect(model.getState().hasStoredPassword).toBe(false);

    const payload = model.buildSavePayload();
    expect(payload.password).toBe("");
  });

  it("typing over a stored password replaces it and cancels a clear request", () => {
    const model = openSshServerFormModel({ server: stored, defaultGroupId: null });
    model.requestClearPassword();
    model.setPasswordDraft("new-secret");
    expect(model.buildSavePayload().password).toBe("new-secret");
  });

  it("surfaces daemon errors at the top of the form", () => {
    const model = openSshServerFormModel(emptySnapshot);
    model.setSubmitError("Address is not reachable");
    expect(model.getState().formError).toBe("Address is not reachable");
  });
});

describe("buildGroupOptions", () => {
  it("renders nested groups as indented paths", () => {
    const options = buildGroupOptions(
      [
        { id: "g1", label: "Prod" },
        { id: "g2", label: "EU", parentId: "g1" },
      ],
      "g1",
    );
    expect(options.map((option) => option.label)).toEqual(["Prod", "  EU"]);
    expect(options.find((option) => option.value === "g1")?.selected).toBe(true);
    expect(options.find((option) => option.value === "g2")?.selected).toBe(false);
  });
});
