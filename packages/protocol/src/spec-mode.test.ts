import { describe, expect, it } from "vitest";
import {
  parseSpecModeMessage,
  specModeApprovalLine,
  specModePhaseOfMessage,
  specModeSharedCheckoutNote,
} from "./spec-mode.js";

/** The shape `renderPromptCommand` produces (header + template body with the argument inlined). */
function promptCommand(phase: string, argument: string): string {
  return [
    `Spec Kit command speckit.${phase}`,
    "",
    "## User Input",
    "",
    "```text",
    argument,
    "```",
    "",
    "You **MUST** consider the user input before proceeding (if not empty).",
    "",
    "## Pre-Execution Checks",
    "",
    "**Check for extension hooks (before specification)**:",
    "",
    "## Context",
    "",
    argument,
    "",
  ].join("\n");
}

const MULTI_LINE = "Add a todo CLI.\nCommands: add, list, done.\n\nStore todos in a JSON file.";
const WITH_BACKTICKS =
  "Add a `--json` flag to `list`.\n\n```sh\ntodo list --json\n```\n\n```text\nnested\n```";

describe("parseSpecModeMessage", () => {
  it("reads the request from a command-directory invocation", () => {
    expect(parseSpecModeMessage("/speckit-specify Add a todo CLI")).toEqual({
      phase: "specify",
      userText: "Add a todo CLI",
    });
    expect(parseSpecModeMessage("$speckit-plan Use SQLite")).toEqual({
      phase: "plan",
      userText: "Use SQLite",
    });
    expect(parseSpecModeMessage("/speckit.tasks Keep tasks small")).toEqual({
      phase: "tasks",
      userText: "Keep tasks small",
    });
  });

  it("reads a multi-line request and one with backticks from an invocation", () => {
    expect(parseSpecModeMessage(`/speckit-specify ${MULTI_LINE}`)).toEqual({
      phase: "specify",
      userText: MULTI_LINE,
    });
    expect(parseSpecModeMessage(`/speckit-specify ${WITH_BACKTICKS}`)).toEqual({
      phase: "specify",
      userText: WITH_BACKTICKS,
    });
  });

  it("reads the request from the User Input block of a rendered prompt command", () => {
    expect(parseSpecModeMessage(promptCommand("specify", "Add a todo CLI"))).toEqual({
      phase: "specify",
      userText: "Add a todo CLI",
    });
    expect(parseSpecModeMessage(promptCommand("specify", MULTI_LINE))).toEqual({
      phase: "specify",
      userText: MULTI_LINE,
    });
    expect(parseSpecModeMessage(promptCommand("plan", WITH_BACKTICKS))).toEqual({
      phase: "plan",
      userText: WITH_BACKTICKS,
    });
  });

  it("reads a Revise note as what the user wrote", () => {
    const note = "Write the JSON file atomically.";
    expect(parseSpecModeMessage(`/speckit-plan ${note}`)).toEqual({
      phase: "plan",
      userText: note,
    });
    expect(parseSpecModeMessage(promptCommand("plan", note))).toEqual({
      phase: "plan",
      userText: note,
    });
  });

  it("returns an empty user part for a phase sent from Approve", () => {
    expect(parseSpecModeMessage("/speckit-plan")).toEqual({ phase: "plan", userText: "" });
    expect(parseSpecModeMessage("$speckit-tasks")).toEqual({ phase: "tasks", userText: "" });
    expect(parseSpecModeMessage(promptCommand("implement", ""))).toEqual({
      phase: "implement",
      userText: "",
    });
    expect(specModeApprovalLine("plan")).toBe("Approved — continue to Plan");
  });

  it("hides the shared-checkout note the daemon appends", () => {
    const note = specModeSharedCheckoutNote("specs/002-list-json");
    expect(parseSpecModeMessage(`/speckit-specify Add a todo CLI\n\n${note}`)).toEqual({
      phase: "specify",
      userText: "Add a todo CLI",
    });
    expect(parseSpecModeMessage(promptCommand("tasks", note))).toEqual({
      phase: "tasks",
      userText: "",
    });
  });

  it("reports an unknown user part when the template has no User Input block", () => {
    expect(parseSpecModeMessage("Spec Kit command speckit.plan\n## Outline\n\nDo things.")).toEqual(
      { phase: "plan", userText: null },
    );
  });

  it("ignores messages that are not phase commands", () => {
    expect(parseSpecModeMessage("Add a todo CLI")).toBeNull();
    expect(parseSpecModeMessage("/speckit-unknown Add a todo CLI")).toBeNull();
    expect(parseSpecModeMessage("/speckit-planning ahead")).toBeNull();
    expect(parseSpecModeMessage("Please run /speckit-plan later")).toBeNull();
    expect(parseSpecModeMessage("Spec Kit command speckit.deploy\nbody")).toBeNull();
  });

  it("agrees with specModePhaseOfMessage on the phase", () => {
    for (const message of ["/speckit-plan x", promptCommand("tasks", "x"), "$speckit-implement"]) {
      expect(parseSpecModeMessage(message)?.phase).toBe(specModePhaseOfMessage(message));
    }
  });
});
