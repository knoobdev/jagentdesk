import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { safeStorage } from "electron";

export interface DesktopSettings {
  daemon: {
    manageBuiltInDaemon: boolean;
    keepRunningAfterQuit: boolean;
  };
  tailscale: {
    authKeyConfigured: boolean;
  };
}

interface DesktopSettingsPatch {
  daemon?: Partial<DesktopSettings["daemon"]>;
  tailscale?: { authKey?: string | null };
}

interface PersistedDesktopSettingsDocument {
  version: 1;
  settings: DesktopSettings;
  tailscaleAuthKeyEncrypted?: string;
  migrations: {
    legacyRendererSettingsImported: boolean;
    // Installs created before the stop-on-quit default persisted the old
    // `keepRunningAfterQuit: true` default to disk, so the new default alone
    // would only reach fresh installs. Reset it once; a later explicit toggle
    // persists this flag and is never overridden again.
    daemonStopOnQuitDefaultApplied: boolean;
  };
}

export interface DesktopSettingsStore {
  get(): Promise<DesktopSettings>;
  patch(patch: unknown): Promise<DesktopSettings>;
  migrateLegacyRendererSettings(legacySettings: unknown): Promise<DesktopSettings>;
  getTailscaleAuthKey(): Promise<string | null>;
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  daemon: {
    manageBuiltInDaemon: true,
    keepRunningAfterQuit: false,
  },
  tailscale: {
    authKeyConfigured: false,
  },
};

const DESKTOP_SETTINGS_FILENAME = "desktop-settings.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function buildDefaultDocument(): PersistedDesktopSettingsDocument {
  return {
    version: 1,
    settings: {
      daemon: { ...DEFAULT_DESKTOP_SETTINGS.daemon },
      tailscale: { ...DEFAULT_DESKTOP_SETTINGS.tailscale },
    },
    migrations: {
      legacyRendererSettingsImported: false,
      daemonStopOnQuitDefaultApplied: true,
    },
  };
}

function coerceDesktopSettings(input: unknown): DesktopSettings {
  const result: DesktopSettings = {
    daemon: { ...DEFAULT_DESKTOP_SETTINGS.daemon },
    tailscale: { ...DEFAULT_DESKTOP_SETTINGS.tailscale },
  };

  if (!isRecord(input)) {
    return result;
  }

  if (isRecord(input.daemon)) {
    const manageBuiltInDaemon = coerceBoolean(input.daemon.manageBuiltInDaemon);
    if (manageBuiltInDaemon !== null) {
      result.daemon.manageBuiltInDaemon = manageBuiltInDaemon;
    }

    const keepRunningAfterQuit = coerceBoolean(input.daemon.keepRunningAfterQuit);
    if (keepRunningAfterQuit !== null) {
      result.daemon.keepRunningAfterQuit = keepRunningAfterQuit;
    }
  }

  if (isRecord(input.tailscale)) {
    result.tailscale.authKeyConfigured = input.tailscale.authKeyConfigured === true;
  }

  return result;
}

function coerceDesktopSettingsPatch(input: unknown): DesktopSettingsPatch {
  if (!isRecord(input)) {
    return {};
  }

  const patch: DesktopSettingsPatch = {};

  if (isRecord(input.daemon)) {
    const daemonPatch: Partial<DesktopSettings["daemon"]> = {};
    const manageBuiltInDaemon = coerceBoolean(input.daemon.manageBuiltInDaemon);
    if (manageBuiltInDaemon !== null) {
      daemonPatch.manageBuiltInDaemon = manageBuiltInDaemon;
    }
    const keepRunningAfterQuit = coerceBoolean(input.daemon.keepRunningAfterQuit);
    if (keepRunningAfterQuit !== null) {
      daemonPatch.keepRunningAfterQuit = keepRunningAfterQuit;
    }
    if (Object.keys(daemonPatch).length > 0) {
      patch.daemon = daemonPatch;
    }
  }

  if (isRecord(input.tailscale) && typeof input.tailscale.authKey === "string") {
    patch.tailscale = { authKey: input.tailscale.authKey };
  } else if (isRecord(input.tailscale) && input.tailscale.authKey === null) {
    patch.tailscale = { authKey: null };
  }

  return patch;
}

function pickDesktopSettingsFromLegacyRendererSettings(
  legacySettings: unknown,
): DesktopSettingsPatch {
  if (!isRecord(legacySettings)) {
    return {};
  }

  const patch: DesktopSettingsPatch = {};
  const manageBuiltInDaemon = coerceBoolean(legacySettings.manageBuiltInDaemon);
  if (manageBuiltInDaemon !== null) {
    patch.daemon = { manageBuiltInDaemon };
  }

  return patch;
}

function mergeDesktopSettings(
  current: DesktopSettings,
  patch: DesktopSettingsPatch,
): DesktopSettings {
  return {
    daemon: { ...current.daemon, ...patch.daemon },
    tailscale: {
      authKeyConfigured:
        patch.tailscale?.authKey !== undefined
          ? patch.tailscale.authKey !== null
          : current.tailscale.authKeyConfigured,
    },
  };
}

function hasLegacyRendererOwnedPatch(patch: DesktopSettingsPatch): boolean {
  return patch.daemon?.manageBuiltInDaemon !== undefined;
}

function coerceDocument(input: unknown): PersistedDesktopSettingsDocument {
  if (!isRecord(input)) {
    return buildDefaultDocument();
  }

  const settings = coerceDesktopSettings(input.settings);
  const migrations = isRecord(input.migrations)
    ? {
        legacyRendererSettingsImported: input.migrations.legacyRendererSettingsImported === true,
        daemonStopOnQuitDefaultApplied: input.migrations.daemonStopOnQuitDefaultApplied === true,
      }
    : {
        legacyRendererSettingsImported: false,
        daemonStopOnQuitDefaultApplied: false,
      };

  if (!migrations.daemonStopOnQuitDefaultApplied) {
    settings.daemon.keepRunningAfterQuit = DEFAULT_DESKTOP_SETTINGS.daemon.keepRunningAfterQuit;
    migrations.daemonStopOnQuitDefaultApplied = true;
  }

  return {
    version: 1,
    settings,
    ...(typeof input.tailscaleAuthKeyEncrypted === "string"
      ? { tailscaleAuthKeyEncrypted: input.tailscaleAuthKeyEncrypted }
      : {}),
    migrations,
  };
}

export function createDesktopSettingsStore({
  userDataPath,
}: {
  userDataPath: string;
}): DesktopSettingsStore {
  const filePath = path.join(userDataPath, DESKTOP_SETTINGS_FILENAME);
  let cachedDocument: PersistedDesktopSettingsDocument | null = null;
  let persistQueue: Promise<void> = Promise.resolve();

  async function persistDocument(document: PersistedDesktopSettingsDocument): Promise<void> {
    const write = async () => {
      await mkdir(userDataPath, { recursive: true });
      const tempFilePath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
      await writeFile(tempFilePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
      await rename(tempFilePath, filePath);
      cachedDocument = document;
    };
    const queued = persistQueue.then(write, write);
    persistQueue = queued.catch(() => undefined);
    await queued;
  }

  async function loadDocument(): Promise<PersistedDesktopSettingsDocument> {
    if (cachedDocument) {
      return cachedDocument;
    }

    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
      const document = buildDefaultDocument();
      await persistDocument(document);
      return document;
    }
    const document = coerceDocument(JSON.parse(raw));
    cachedDocument = document;
    return document;
  }

  async function loadWritableDocument(): Promise<PersistedDesktopSettingsDocument> {
    const document = await loadDocument();
    await persistDocument(document);
    return document;
  }

  async function initializeLegacyRendererMigration(): Promise<PersistedDesktopSettingsDocument> {
    try {
      return await loadDocument();
    } catch {
      const document = buildDefaultDocument();
      await persistDocument(document);
      return document;
    }
  }

  return {
    async get(): Promise<DesktopSettings> {
      const document = await loadDocument();
      return document.settings;
    },

    async patch(patch: unknown): Promise<DesktopSettings> {
      const current = await loadWritableDocument();
      const coercedPatch = coerceDesktopSettingsPatch(patch);
      const next = mergeDesktopSettings(current.settings, coercedPatch);
      let tailscaleAuthKeyEncrypted = current.tailscaleAuthKeyEncrypted;
      if (coercedPatch.tailscale?.authKey !== undefined) {
        if (coercedPatch.tailscale.authKey === null) {
          tailscaleAuthKeyEncrypted = undefined;
        } else {
          if (!safeStorage.isEncryptionAvailable()) {
            throw new Error("OS secure storage is unavailable; Tailscale auth key was not saved");
          }
          tailscaleAuthKeyEncrypted = safeStorage
            .encryptString(coercedPatch.tailscale.authKey)
            .toString("base64");
        }
      }
      await persistDocument({
        ...current,
        settings: next,
        ...(tailscaleAuthKeyEncrypted
          ? { tailscaleAuthKeyEncrypted }
          : { tailscaleAuthKeyEncrypted: undefined }),
        migrations: {
          ...current.migrations,
          legacyRendererSettingsImported:
            current.migrations.legacyRendererSettingsImported ||
            hasLegacyRendererOwnedPatch(coercedPatch),
        },
      });
      return next;
    },

    async getTailscaleAuthKey(): Promise<string | null> {
      const document = await loadDocument();
      if (!document.tailscaleAuthKeyEncrypted || !safeStorage.isEncryptionAvailable()) {
        return null;
      }
      try {
        return safeStorage.decryptString(Buffer.from(document.tailscaleAuthKeyEncrypted, "base64"));
      } catch {
        return null;
      }
    },

    async migrateLegacyRendererSettings(legacySettings: unknown): Promise<DesktopSettings> {
      const current = await initializeLegacyRendererMigration();
      if (current.migrations.legacyRendererSettingsImported) {
        return current.settings;
      }

      const next = mergeDesktopSettings(
        current.settings,
        pickDesktopSettingsFromLegacyRendererSettings(legacySettings),
      );
      await persistDocument({
        ...current,
        settings: next,
        migrations: {
          ...current.migrations,
          legacyRendererSettingsImported: true,
        },
      });
      return next;
    },
  };
}
