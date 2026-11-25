import { homedir } from "node:os";
import type {
  BuiltinDaemonRef,
  BuiltinServerHost,
} from "../../../packages/server/src/server/plugins/builtin/host-api.js";
import { registerSkillsTools } from "./agent-tools.js";
import { NativeSkillsService } from "./service.js";
import { SkillsSession } from "./session.js";

let skillsServiceRef: BuiltinDaemonRef<NativeSkillsService> | undefined;
/** The daemon's native skills service; tests install their own instance through this ref. */
export function skillsService(): BuiltinDaemonRef<NativeSkillsService> {
  if (!skillsServiceRef) throw new Error("Skills built-in is not registered");
  return skillsServiceRef;
}

export function register(host: BuiltinServerHost) {
  // Native SKILL.md skills (spec 22 / ADR-0022). Also serves the legacy skills.get /
  // skills.mutate API (COMPAT(nativeSkills)) and migrates skills.json once (22.10).
  let unsubscribe: (() => void) | undefined;
  const ref = host.daemonService(
    async (context) => {
      const service = new NativeSkillsService({
        jagentdeskHome: context.home,
        homeDir: homedir(),
        logger: context.logger,
      });
      await service.initialize();
      unsubscribe = service.onChange((skills) => {
        context.broadcast({
          type: "status",
          // Every change (legacy mutate or native op) also invalidates the native catalog.
          payload: { status: "skills_changed", skills, catalogChanged: true },
        });
      });
      return service;
    },
    () => unsubscribe?.(),
  );
  skillsServiceRef = ref;
  host.provide("skillInvocation", (daemon) => ref.get(daemon));
  host.rpc(
    "skills.",
    [
      "skills.catalog.list.request",
      "skills.catalog.get.request",
      "skills.sources.browse.request",
      "skills.sources.list.request",
      "skills.sources.add.request",
      "skills.sources.remove.request",
      "skills.sources.set_enabled.request",
      "skills.sources.set_api_key.request",
      "skills.install.request",
      "skills.uninstall.request",
      "skills.set_enabled.request",
      "skills.author.request",
      "skills.learn.request",
      "skills.fork.request",
      "skills.get.request",
      "skills.mutate.request",
    ],
    (services) => new SkillsSession(ref.get(services.daemon) ?? null, services.push),
  );
  host.agentTools((registerTool, context) =>
    registerSkillsTools(registerTool, ref.get(context?.daemon), context),
  );
}
