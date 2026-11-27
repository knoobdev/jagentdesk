import { describe, expect, it } from "vitest";
import { createInstance } from "i18next";
import { botsStrings } from "@/i18n/resources/bots";
import {
  checkSummary,
  flagPart,
  flagWhere,
  partValue,
  pickedOf,
  selectionWith,
  shareErrorCopy,
  toggled,
} from "./share-model";

const i18n = createInstance();
await i18n.init({ lng: "en", resources: { en: { translation: { bots: botsStrings } } } });
const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options);

describe("share model", () => {
  it("summarizes the safety check with secrets first", () => {
    expect(checkSummary([], t)).toBe("Nothing found");
    expect(checkSummary([{ where: "SOUL.md", line: 2, kind: "sudo" }], t)).toBe("1 warning");
    expect(
      checkSummary(
        [
          { where: "skills/a/SKILL.md", line: 3, kind: "secret" },
          { where: "SOUL.md", line: 1, kind: "sudo" },
        ],
        t,
      ),
    ).toBe("1 secret found");
  });

  it("opens the part a flag is in", () => {
    expect(flagPart({ where: "skills/release-notes/SKILL.md", line: 4, kind: "secret" })).toBe(
      "skill:release-notes",
    );
    expect(flagPart({ where: "memory/repo-facts.md", line: 1, kind: "secret" })).toBe(
      "memory:repo-facts",
    );
    expect(flagPart({ where: "bot.json#setupNote", line: 1, kind: "secret" })).toBe("note");
    expect(flagWhere({ where: "SOUL.md", line: 7, kind: "sudo" }, t)).toBe("SOUL.md, line 7");
  });

  it("keeps absent picks as every part and toggles back to absent", () => {
    const all = ["a", "b", "c"];
    expect(pickedOf(undefined, all)).toEqual(all);
    const without = toggled(undefined, all, "b", false);
    expect(without).toEqual(["a", "c"]);
    expect(toggled(without, all, "b", true)).toBeUndefined();
    expect(partValue(["a", "c"], 3, t)).toBe("2 of 3");
    expect(partValue(all, 3, t)).toBe("a, b, c");
    expect(selectionWith({ skills: ["a"] }, { skills: undefined })).toEqual({});
  });

  it("maps share error codes to their copy and strips the RPC suffix of others", () => {
    expect(
      shareErrorCopy(new Error("bot_share_too_large requestType=bots.share.publish.request"), t),
    ).toBe("This bot is too large to share. Leave out some memory or skills, then try again.");
    expect(shareErrorCopy(new Error("bot_share_relay_off"), t)).toBe(
      "Turn on the relay in Settings › Connections to share bots.",
    );
    expect(
      shareErrorCopy(
        new Error("Bot not found requestType=bots.share.status.request code=bots_error"),
        t,
      ),
    ).toBe("Bot not found");
  });
});
