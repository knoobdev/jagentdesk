export interface DesktopStartupDependencies {
  hasPendingGuiLaunchRequest: boolean;
  runCliPassthroughIfRequested: () => Promise<boolean>;
  inheritLoginShellEnv: () => void | Promise<void>;
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
  // Finder/Dock launches inherit a tiny environment. Shell discovery is useful
  // for later agent processes, but it must not compete with the first renderer
  // paint. Keep it off the cold path even when the user's shell takes seconds.
  const defer = deps.defer ?? ((task: () => void) => setTimeout(task, 15_000));
  defer(() => {
    void deps.inheritLoginShellEnv();
  });
  if (deps.autoUpdateInstalledSkills) {
    defer(() => deps.autoUpdateInstalledSkills?.());
  }
}
