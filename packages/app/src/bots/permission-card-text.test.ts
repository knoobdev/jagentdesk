import { describe, expect, it } from "vitest";
import { createInstance } from "i18next";
import { botPermissionRequestText } from "@jagentdesk/protocol/bots/permission-cards";
import { botsStrings } from "@/i18n/resources/bots";
import { botPermissionCardText } from "./permission-card-text";

// The English strings, resolved the way the app resolves them.
const i18n = createInstance();
await i18n.init({
  lng: "en",
  resources: { en: { translation: { bots: botsStrings } } },
  interpolation: { escapeValue: false },
});
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options);

describe("bot permission card text (spec 37.3.2-37.3.3)", () => {
  it("words a worker start for the owner, from the request's card", () => {
    const request = botPermissionRequestText({
      kind: "worker_start",
      botName: "Release helper",
      itemNumber: 2,
      itemTitle: "Bump the version",
      projectPath: "/Users/me/code/shop",
      projectName: "shop",
      task: "Bump package.json to 1.4.0 and open a PR.",
    });
    const text = botPermissionCardText({ metadata: request.metadata }, t);
    expect(text).toEqual({
      title: "Start a worker for #2 Bump the version?",
      description:
        "Release helper starts a worker in a new worktree of shop (/Users/me/code/shop). The worker reports back when it is done.",
      detail: {
        type: "plain_text",
        label: "Task",
        text: "Bump package.json to 1.4.0 and open a PR.",
      },
    });
    // The app's words match the daemon's English for older apps.
    expect(text?.title).toBe(request.title);
    expect(text?.description).toBe(request.description);
  });

  it("words each kind of hand-off", () => {
    for (const [type, title] of [
      ["handoff", "Hand this to Docs bot?"],
      ["question", "Ask Docs bot?"],
      ["status", "Send Docs bot a status?"],
    ] as const) {
      const { metadata } = botPermissionRequestText({
        kind: "handoff",
        botName: "Release helper",
        toBotName: "Docs bot",
        type,
        text: "Hi",
      });
      expect(botPermissionCardText({ metadata }, t)?.title).toBe(title);
    }
  });

  it("leaves other requests to the daemon's own title", () => {
    expect(botPermissionCardText({ metadata: undefined }, t)).toBeNull();
    expect(botPermissionCardText({ metadata: { planText: "x" } }, t)).toBeNull();
  });
});
