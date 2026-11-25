import type { PluginServerContext } from "@jagentdesk/plugin/server";
import { copyWorktreeIncludes } from "./server/copy.js";

export default function contribute(server: PluginServerContext) {
  return server.addHook("worktree.create.after", async ({ worktree }) => {
    await copyWorktreeIncludes(worktree.path, worktree.sourceCheckout);
  });
}
