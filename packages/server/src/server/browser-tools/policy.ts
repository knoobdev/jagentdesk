import type { DaemonConfigStore, MutableDaemonConfig } from "../daemon-config-store.js";

export interface BrowserToolsPolicy {
  isEnabled(): boolean;
}

export class DaemonConfigBrowserToolsPolicy implements BrowserToolsPolicy {
  public constructor(private readonly configStore: Pick<DaemonConfigStore, "get">) {}

  public isEnabled(): boolean {
    const config = this.configStore.get();
    return config.builtinPlugins?.["browser-tools"]?.enabled ?? readBrowserToolsEnabled(config);
  }
}

function readBrowserToolsEnabled(config: MutableDaemonConfig): boolean {
  const browserTools = config.browserTools;
  if (typeof browserTools !== "object" || browserTools === null || Array.isArray(browserTools)) {
    return false;
  }
  return browserTools.enabled === true;
}
