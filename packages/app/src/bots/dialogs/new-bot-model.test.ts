import { describe, expect, it } from "vitest";
import type { ProviderSnapshotEntry } from "@jagentdesk/protocol/agent-types";
import { PICKABLE_BOT_MASCOT_IDS } from "@jagentdesk/protocol/bots/rules";
import {
  NewBotFormModel,
  botFolderPreview,
  filterPickerOptions,
  mascotAvatar,
  templateIdentity,
  wrapIndex,
} from "./new-bot-model";

const opencode: ProviderSnapshotEntry = {
  provider: "opencode",
  status: "ready",
  enabled: true,
  label: "OpenCode",
  models: [
    { provider: "opencode", id: "big/large-model", label: "Large", isDefault: true },
    { provider: "opencode", id: "google/gemini-flash", label: "Gemini Flash" },
    { provider: "opencode", id: "lite/flash-lite", label: "Lite" },
    { provider: "opencode", id: "f/lash-split", label: "Split letters" },
  ],
} as ProviderSnapshotEntry;
const offline: ProviderSnapshotEntry = {
  provider: "codex",
  status: "unavailable",
  enabled: true,
  label: "Codex",
} as ProviderSnapshotEntry;

function form() {
  const model = new NewBotFormModel({ mascotIndex: 0 });
  model.applyProviders([offline, opencode], true);
  return model;
}

describe("NewBotFormModel", () => {
  it("needs a name: Create shows Add a name and does not submit", () => {
    const model = form();
    expect(model.submit()).toBe(false);
    expect(model.getState().submitted).toBe(true);
    expect(model.getState().nameMissing).toBe(true);
    model.setName("Reviewer");
    expect(model.submit()).toBe(true);
  });

  it("counts identity from 160 and blocks 201 characters, allows 200", () => {
    const model = form();
    model.setName("Reviewer");
    model.setIdentity("a".repeat(159));
    expect(model.getState().showIdentityCounter).toBe(false);
    model.setIdentity("a".repeat(160));
    expect(model.getState().showIdentityCounter).toBe(true);
    model.setIdentity("a".repeat(201));
    expect(model.getState().identityTooLong).toBe(true);
    expect(model.submit()).toBe(false);
    model.setIdentity("a".repeat(200));
    expect(model.getState().identityTooLong).toBe(false);
    expect(model.submit()).toBe(true);
  });

  it("an empty identity is not sent", () => {
    const model = form();
    model.setIdentity("   ");
    expect(model.identityToSend()).toBeUndefined();
  });

  it("takes the first ready provider and its default model", () => {
    const state = form().getState();
    expect(state.provider).toBe("opencode");
    expect(state.model).toBe("big/large-model");
    expect(state.providers.map((entry) => entry.provider)).toEqual(["opencode"]);
  });

  it("blocks Create with no ready provider", () => {
    const model = new NewBotFormModel({ mascotIndex: 0 });
    model.applyProviders([offline], true);
    model.setName("Reviewer");
    expect(model.getState().noAgents).toBe(true);
    expect(model.submit()).toBe(false);
  });

  it("keeps a template's identity out of the limit until edited", () => {
    const model = new NewBotFormModel({
      mascotIndex: 0,
      template: {
        id: "pr-review",
        name: "Pull request review",
        mascot: "E1",
        watches: "",
        does: "",
        reports: "",
      },
      templateIdentityText: "x".repeat(300),
    });
    model.applyProviders([opencode], true);
    const state = model.getState();
    expect(state.name).toBe("Pull request review");
    expect(model.picture().avatar).toBe("mascot:E1");
    expect(state.identityTooLong).toBe(false);
    expect(model.identityToSend()).toBeUndefined();
    model.setIdentity("y".repeat(300));
    expect(model.getState().identityTooLong).toBe(true);
  });
});

describe("filterPickerOptions", () => {
  it("matches name or id as a substring, any case, never scattered letters", () => {
    const options = (opencode.models ?? []).map((model) => ({ id: model.id, label: model.label }));
    expect(filterPickerOptions(options, "FLASH").map((option) => option.id)).toEqual([
      "google/gemini-flash",
      "lite/flash-lite",
    ]);
    expect(filterPickerOptions(options, "")).toHaveLength(4);
  });
});

describe("picture carousel", () => {
  it("Next picture 19 times comes back to the first mascot", () => {
    let index = 0;
    for (let step = 0; step < PICKABLE_BOT_MASCOT_IDS.length; step += 1) {
      index = wrapIndex(index + 1, PICKABLE_BOT_MASCOT_IDS.length);
    }
    expect(PICKABLE_BOT_MASCOT_IDS).toHaveLength(19);
    expect(index).toBe(0);
    expect(wrapIndex(-1, 19)).toBe(18);
    expect(mascotAvatar(19)).toBe(mascotAvatar(0));
  });

  it("never offers the retired S2", () => {
    expect(PICKABLE_BOT_MASCOT_IDS).not.toContain("S2");
  });
});

describe("botFolderPreview", () => {
  it("adds -2 for a folder another bot holds, under the bots directory", () => {
    const bots = [{ slug: "reviewer", folder: "reviewer", home: "/h/bots/reviewer" }];
    expect(botFolderPreview("Reviewer", bots)).toBe("/h/bots/reviewer-2");
    expect(botFolderPreview("New One", [])).toBe("new-one");
  });
});

describe("templateIdentity", () => {
  it("joins what it watches, does and reports as sentences", () => {
    const say = {
      watches: (what: string) => `Watches ${what}`,
      reports: (what: string) => `Reports ${what}`,
    };
    expect(
      templateIdentity({ watches: "PRs", does: "Reviews each one.", reports: "here" }, say),
    ).toBe("Watches PRs. Reviews each one. Reports here.");
  });
});
