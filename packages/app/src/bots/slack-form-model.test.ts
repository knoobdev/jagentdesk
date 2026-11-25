import { expect, it } from "vitest";
import { SlackFormModel } from "./slack-form-model";
it("requires both credentials and clears sensitive input after connect", () => {
  const model = new SlackFormModel();
  expect(model.getState().canSubmit).toBe(false);
  model.set("botToken", " token ");
  expect(model.getState().canSubmit).toBe(false);
  model.set("signingSecret", " secret ");
  expect(model.input()).toEqual({ botToken: "token", signingSecret: "secret" });
  model.clear();
  expect(model.getState()).toEqual({
    botToken: "",
    signingSecret: "",
    canSubmit: false,
    revision: 1,
  });
});
