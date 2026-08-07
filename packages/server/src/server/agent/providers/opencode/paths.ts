import path from "node:path";

import { resolveJAgentDeskHome } from "../../../jagentdesk-home.js";

const OPENCODE_HOME_DIRNAME = "opencode-home";

export function resolveOpenCodeHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveJAgentDeskHome(env), OPENCODE_HOME_DIRNAME);
}
