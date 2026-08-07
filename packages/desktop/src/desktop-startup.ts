export interface DesktopStartupDependencies {
  hasPendingGuiLaunchRequest: boolean;
  runCliPassthroughIfRequested: () => Promise<boolean>;
  inheritLoginShellEnv: () => void;
  bootstrapGui: () => Promise<void>;
  /** Schedule shell discovery after the first window is available. */
  defer?: (task: () => void) => void;
  autoUpdateInstalledSkills?: () => void;
}

export async function runDesktopStartup(deps: DesktopStartupDependencies): Promise<void> {
  if (!deps.hasPendingGuiLaunchRequest && (await deps.runCliPassthroughIfRequested())) {
    return;
  }

  await deps.bootstrapGui();
  // Login-shell discovery can invoke a user's interactive shell and block for
  // up to its timeout. Never put that synchronous work on the cold-start path:
  // the packaged app must render its first window before environment probing.
  const defer = deps.defer ?? ((task: () => void) => setTimeout(task, 0));
  defer(deps.inheritLoginShellEnv);
  deps.autoUpdateInstalledSkills?.();
}
