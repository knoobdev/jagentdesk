import { describe, expect, it } from "vitest";
import {
  SPEC_MODE_PHASES,
  parseSpecModeMessage,
  specModeSharedCheckoutNote,
} from "@jagentdesk/protocol/spec-mode";
import { commandInvocation, specKitIntegrationFor } from "./layout.js";
import { renderPromptCommand } from "./render.js";
import { loadSpecKitSources } from "./vendor.js";

const REQUEST =
  "Add a `list --json` flag.\n\n```sh\ntodo list --json\n```\nKeep the text output unchanged.";

describe("Spec mode chat bubble round trip (spec 28.4 step 2)", () => {
  it("recovers what the user wrote from every rendered prompt command", async () => {
    const sources = await loadSpecKitSources();
    for (const phase of SPEC_MODE_PHASES) {
      for (const args of [REQUEST, ""]) {
        const message = renderPromptCommand({
          command: phase,
          raw: sources.commands[phase],
          script: "sh",
          args,
        });
        expect(parseSpecModeMessage(message)).toEqual({ phase, userText: args });
      }
    }
  });

  it("drops the shared-checkout note the daemon appends to the argument", async () => {
    const sources = await loadSpecKitSources();
    const note = specModeSharedCheckoutNote("specs/002-list-json");
    const prompt = renderPromptCommand({
      command: "plan",
      raw: sources.commands.plan,
      script: "sh",
      args: `${REQUEST}\n\n${note}`,
    });
    expect(parseSpecModeMessage(prompt)).toEqual({ phase: "plan", userText: REQUEST });
    expect(parseSpecModeMessage(`/speckit-plan ${note}`)).toEqual({ phase: "plan", userText: "" });
  });

  it("recovers the argument from command-directory invocations", () => {
    const invocations = ["claude", "codex", "opencode"].map((provider) => {
      const integration = specKitIntegrationFor(provider);
      if (integration.kind === "prompt") throw new Error(`${provider} has no command directory`);
      return commandInvocation(integration, "specify");
    });
    expect(invocations).toEqual(["/speckit-specify", "$speckit-specify", "/speckit.specify"]);
    for (const invocation of invocations) {
      expect(parseSpecModeMessage(`${invocation} ${REQUEST}`)).toEqual({
        phase: "specify",
        userText: REQUEST,
      });
      expect(parseSpecModeMessage(invocation)).toEqual({ phase: "specify", userText: "" });
    }
  });
});
