import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { BrowserKeyboardPolicy } from "./features/browser-keyboard/index.js";

// This preload runs in Electron's sandbox and is tsc-compiled (not bundled), so it MUST
// NOT emit any runtime module load other than "electron" — a require() of a local or
// third-party module throws and aborts the preload before exposeInMainWorld runs, leaving
// window.jagentdeskDesktop undefined (the 0.1.108 regression, #2103). Keep this literal in sync
// with JAGENTDESK_BROWSER_PROFILE_PARTITION in features/browser-profile.ts; preload-sandbox.test.ts
// guards both the no-local-import rule and this drift. Type-only imports are fine (erased at emit).
const JAGENTDESK_BROWSER_PROFILE_PARTITION = "persist:jagentdesk-browser";

type EventHandler = (payload: unknown) => void;

interface AttachedBrowserRegistration {
  browserId: string;
  workspaceId: string;
  webContentsId: number;
}

contextBridge.exposeInMainWorld("jagentdeskDesktop", {
  platform: process.platform,
  invoke: (command: string, args?: Record<string, unknown>) =>
    ipcRenderer.invoke("jagentdesk:invoke", command, args),
  getPendingOpenProject: () =>
    ipcRenderer.invoke("jagentdesk:get-pending-open-project") as Promise<string | null>,
  agentNavigation: {
    ready: () =>
      ipcRenderer.invoke("jagentdesk:agent-navigation:ready") as Promise<{
        serverId: string;
        agentId: string;
      } | null>,
  },
  events: {
    on: (event: string, handler: EventHandler): Promise<() => void> => {
      const listener = (_ipcEvent: Electron.IpcRendererEvent, payload: unknown) => {
        handler(payload);
      };
      ipcRenderer.on(`jagentdesk:event:${event}`, listener);
      return Promise.resolve(() => {
        ipcRenderer.removeListener(`jagentdesk:event:${event}`, listener);
      });
    },
  },
  window: {
    openNew: (options?: { pendingOpenProjectPath?: string | null }) =>
      ipcRenderer.invoke("jagentdesk:window:openNew", options),
    getCurrentWindow: () => ({
      toggleMaximize: () => ipcRenderer.invoke("jagentdesk:window:toggleMaximize"),
      setFullscreen: (fullscreen: boolean) =>
        ipcRenderer.invoke("jagentdesk:window:setFullscreen", fullscreen),
      isFullscreen: () => ipcRenderer.invoke("jagentdesk:window:isFullscreen"),
      updateWindowControls: (update: {
        height?: number;
        backgroundColor?: string;
        foregroundColor?: string;
        trafficLightOffsetY?: number;
      }) => ipcRenderer.invoke("jagentdesk:window:updateWindowControls", update),
      onResized: (handler: EventHandler): (() => void) => {
        const listener = (_ipcEvent: Electron.IpcRendererEvent, payload: unknown) => {
          handler(payload);
        };
        ipcRenderer.on("jagentdesk:window:resized", listener);
        return () => {
          ipcRenderer.removeListener("jagentdesk:window:resized", listener);
        };
      },
      setBadgeCount: (count?: number) =>
        ipcRenderer.invoke("jagentdesk:window:setBadgeCount", count),
    }),
  },
  dialog: {
    ask: (message: string, options?: Record<string, unknown>) =>
      ipcRenderer.invoke("jagentdesk:dialog:ask", message, options),
    askWithCheckbox: (message: string, options: Record<string, unknown>) =>
      ipcRenderer.invoke("jagentdesk:dialog:askWithCheckbox", message, options),
    open: (options?: Record<string, unknown>) =>
      ipcRenderer.invoke("jagentdesk:dialog:open", options),
  },
  notification: {
    isSupported: () => ipcRenderer.invoke("jagentdesk:notification:isSupported"),
    sendNotification: (payload: { title: string; body?: string; data?: Record<string, unknown> }) =>
      ipcRenderer.invoke("jagentdesk:notification:send", payload),
  },
  opener: {
    openUrl: (url: string) => ipcRenderer.invoke("jagentdesk:opener:openUrl", url),
  },
  editor: {
    listTargets: () => ipcRenderer.invoke("jagentdesk:editor:listTargets"),
    openTarget: (input: {
      editorId: string;
      workspacePath: string;
      filePath?: string;
      line?: number;
      column?: number;
    }) => ipcRenderer.invoke("jagentdesk:editor:openTarget", input),
  },
  webUtils: {
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
  },
  menu: {
    showContextMenu: (input?: Record<string, unknown>) =>
      ipcRenderer.invoke("jagentdesk:menu:showContextMenu", input),
    setCapturingShortcut: (capturing: boolean) =>
      ipcRenderer.invoke("jagentdesk:menu:set-capturing-shortcut", capturing),
  },
  browser: {
    setShortcutPolicy: (input: BrowserKeyboardPolicy) =>
      ipcRenderer.invoke("jagentdesk:browser:set-shortcut-policy", input),
    profilePartition: JAGENTDESK_BROWSER_PROFILE_PARTITION,
    registerAttachedBrowser: (input: AttachedBrowserRegistration) =>
      ipcRenderer.invoke("jagentdesk:browser:register-attached", input),
    unregisterWorkspaceBrowser: (browserId: string) =>
      ipcRenderer.invoke("jagentdesk:browser:unregister-workspace-browser", browserId),
    setWorkspaceActiveBrowser: (input: { workspaceId: string; browserId: string | null }) =>
      ipcRenderer.invoke("jagentdesk:browser:set-workspace-active-browser", input),
    focus: (browserId: string) => ipcRenderer.invoke("jagentdesk:browser:focus", browserId),
    openDevTools: (browserId: string) =>
      ipcRenderer.invoke("jagentdesk:browser:open-devtools", browserId),
    clearProfile: (legacyBrowserIds: string[]) =>
      ipcRenderer.invoke("jagentdesk:browser:clear-profile", legacyBrowserIds),
    executeAutomationCommand: (request: Record<string, unknown>) =>
      ipcRenderer.invoke("jagentdesk:browser:execute-automation-command", request),
    captureElement: (
      browserId: string,
      rect: { x: number; y: number; width: number; height: number },
    ) => ipcRenderer.invoke("jagentdesk:browser:capture-element", browserId, rect),
    copyElement: (payload: { text?: string; imageDataUrl?: string }) =>
      ipcRenderer.invoke("jagentdesk:browser:copy-element", payload),
    setStealthEnabled: (enabled: boolean) =>
      ipcRenderer.invoke("jagentdesk:browser:set-stealth", enabled),
    listConnectedLogins: () => ipcRenderer.invoke("jagentdesk:browser:list-connected-logins"),
    saveConnectedLogin: (browserId: string) =>
      ipcRenderer.invoke("jagentdesk:browser:save-connected-login", browserId),
    deleteConnectedLogin: (domain: string) =>
      ipcRenderer.invoke("jagentdesk:browser:delete-connected-login", domain),
  },
});
