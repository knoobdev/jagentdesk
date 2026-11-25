import type { BuiltinClientHost } from "../../../packages/app/src/plugins/builtin/host-api";
import { SpecModeComposerDock } from "./composer-dock";
import { SpecModeMessageBody } from "./message-body";
import { SpecModeControl } from "./spec-mode-control";

export function register(app: BuiltinClientHost) {
  app.agentControl("spec-mode", SpecModeControl);
  app.agentComposerDock("spec-mode", SpecModeComposerDock);
  app.userMessageBody(SpecModeMessageBody);
}
