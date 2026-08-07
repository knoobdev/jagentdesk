import { Command } from "commander";
import { runLsCommand } from "./ls.js";
import { runAllowCommand } from "./allow.js";
import { runDenyCommand } from "./deny.js";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";

export function createPermitCommand(): Command {
  const permit = new Command("permit").description("Manage permission requests");

  addJsonAndDaemonHostOptions(
    permit.command("ls").description("List all pending permissions"),
  ).action(withOutput(runLsCommand));

  addJsonAndDaemonHostOptions(
    permit
      .command("allow")
      .description("Allow a permission request")
      .argument("<agent>", "Agent ID (or prefix)")
      .argument("[req_id]", "Permission request ID (optional if --all)")
      .option("--all", "Allow all pending permissions for this agent")
      .option("--input <json>", "Modified input parameters (JSON)"),
  ).action(withOutput(runAllowCommand));

  addJsonAndDaemonHostOptions(
    permit
      .command("deny")
      .description("Deny a permission request")
      .argument("<agent>", "Agent ID (or prefix)")
      .argument("[req_id]", "Permission request ID (optional if --all)")
      .option("--all", "Deny all pending permissions for this agent")
      .option("--message <msg>", "Denial reason message")
      .option("--interrupt", "Stop agent after denial"),
  ).action(withOutput(runDenyCommand));

  return permit;
}
