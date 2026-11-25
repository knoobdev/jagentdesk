import type { BuiltinClientHost } from "../../../packages/app/src/plugins/builtin/host-api";
import { CustomProvidersSection } from "./custom-providers-section";

/** Spec 34: the custom API providers card on the host's Settings → Providers page. */
export function register(app: BuiltinClientHost) {
  app.providerSettingsSection("custom-providers", CustomProvidersSection);
}
