import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useSessionStore, type AgentFileExplorerState } from "@/stores/session-store";
import { explorerFileFromReadResult } from "@/file-explorer/read-result";
import {
  loadExplorerDirectory,
  type DirectoryListingResult,
  invalidateExplorerDirectoryListings,
} from "@/file-explorer/directory-listings";

function createExplorerState(): AgentFileExplorerState {
  return {
    listingGeneration: 0,
    directories: new Map(),
    files: new Map(),
    isLoading: false,
    lastError: null,
    pendingRequest: null,
    currentPath: ".",
    history: ["."],
    lastVisitedPath: ".",
    selectedEntryPath: null,
  };
}

export interface FileExplorerWorkspaceScope {
  workspaceId?: string | null;
  workspaceRoot?: string | null;
}

function normalizeWorkspaceValue(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function buildWorkspaceExplorerStateKey(scope: FileExplorerWorkspaceScope): string | null {
  const normalizedWorkspaceId = normalizeWorkspaceValue(scope.workspaceId);
  if (normalizedWorkspaceId) {
    return `workspace:${normalizedWorkspaceId}`;
  }
  const normalizedWorkspaceRoot = normalizeWorkspaceValue(scope.workspaceRoot);
  if (!normalizedWorkspaceRoot) {
    return null;
  }
  return `root:${normalizedWorkspaceRoot}`;
}

export function useFileExplorerActions(params: { serverId: string } & FileExplorerWorkspaceScope) {
  const { t } = useTranslation();
  const { serverId, workspaceId, workspaceRoot } = params;
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const setFileExplorer = useSessionStore((state) => state.setFileExplorer);
  const normalizedWorkspaceRoot = useMemo(
    () => normalizeWorkspaceValue(workspaceRoot),
    [workspaceRoot],
  );
  const workspaceStateKey = useMemo(
    () =>
      buildWorkspaceExplorerStateKey({
        workspaceId,
        workspaceRoot: normalizedWorkspaceRoot,
      }),
    [workspaceId, normalizedWorkspaceRoot],
  );

  const updateExplorerState = useCallback(
    (
      updater: (prev: AgentFileExplorerState) => AgentFileExplorerState,
    ): AgentFileExplorerState | null => {
      if (!workspaceStateKey) {
        return null;
      }
      let updated: AgentFileExplorerState | null = null;
      setFileExplorer(serverId, (prev) => {
        const next = new Map(prev);
        const current = next.get(workspaceStateKey) ?? createExplorerState();
        updated = updater(current);
        next.set(workspaceStateKey, updated);
        return next;
      });
      return updated;
    },
    [serverId, setFileExplorer, workspaceStateKey],
  );

  const requestDirectoryListing = useCallback(
    async (
      path: string,
      options?: { recordHistory?: boolean; setCurrentPath?: boolean },
    ): Promise<DirectoryListingResult> => {
      if (!workspaceStateKey) {
        return null;
      }
      const normalizedPath = path && path.length > 0 ? path : ".";
      return loadExplorerDirectory({
        path: normalizedPath,
        options,
        updateState: updateExplorerState,
        fallbackError: t("workspace.fileExplorer.errors.failedToListDirectory"),
        listDirectory: async () => {
          if (!normalizedWorkspaceRoot)
            throw new Error(t("workspace.fileExplorer.states.unavailable"));
          if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
          return client.listDirectory(normalizedWorkspaceRoot, normalizedPath);
        },
      });
    },
    [client, normalizedWorkspaceRoot, t, updateExplorerState, workspaceStateKey],
  );

  const requestFilePreview = useCallback(
    async (path: string) => {
      if (!workspaceStateKey) {
        return;
      }
      const normalizedPath = path && path.length > 0 ? path : ".";
      updateExplorerState((state) => ({
        ...state,
        isLoading: true,
        lastError: null,
        pendingRequest: { path: normalizedPath, mode: "file" },
      }));

      if (!normalizedWorkspaceRoot) {
        updateExplorerState((state) => ({
          ...state,
          isLoading: false,
          lastError: t("workspace.fileExplorer.states.unavailable"),
          pendingRequest: null,
        }));
        return;
      }

      if (!client) {
        updateExplorerState((state) => ({
          ...state,
          isLoading: false,
          lastError: t("workspace.terminal.hostDisconnected"),
          pendingRequest: null,
        }));
        return;
      }

      try {
        const file = await client.readFile(normalizedWorkspaceRoot, normalizedPath);
        updateExplorerState((state) => {
          const nextState: AgentFileExplorerState = {
            ...state,
            isLoading: false,
            lastError: null,
            pendingRequest: null,
            directories: state.directories,
            files: state.files,
          };

          const files = new Map(state.files);
          const explorerFile = explorerFileFromReadResult(file);
          files.set(explorerFile.path, explorerFile);
          nextState.files = files;

          return nextState;
        });
      } catch (error) {
        updateExplorerState((state) => ({
          ...state,
          isLoading: false,
          lastError: error instanceof Error ? error.message : t("panels.file.failedToLoadPreview"),
          pendingRequest: null,
        }));
      }
    },
    [client, normalizedWorkspaceRoot, t, updateExplorerState, workspaceStateKey],
  );

  const requestFileDownloadToken = useCallback(
    async (path: string) => {
      if (!normalizedWorkspaceRoot) {
        throw new Error(t("workspace.fileExplorer.states.unavailable"));
      }
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const payload = await client.requestDownloadToken(normalizedWorkspaceRoot, path);
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload;
    },
    [client, normalizedWorkspaceRoot, t],
  );

  const requestFileBytes = useCallback(
    async (path: string, maxBytes: number) => {
      if (!normalizedWorkspaceRoot) {
        throw new Error(t("workspace.fileExplorer.states.unavailable"));
      }
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      // No request timeout: a large file over a slow relay legitimately takes longer than the
      // 60 s default, and a dead connection still rejects on disconnect.
      return client.readFile(normalizedWorkspaceRoot, path, undefined, maxBytes, 0);
    },
    [client, normalizedWorkspaceRoot, t],
  );

  const selectExplorerEntry = useCallback(
    (path: string | null) => {
      updateExplorerState((state) => ({
        ...state,
        selectedEntryPath: path,
      }));
    },
    [updateExplorerState],
  );

  const invalidateDirectoryListings = useCallback(
    (retainedPaths: readonly string[]) =>
      invalidateExplorerDirectoryListings(updateExplorerState, retainedPaths),
    [updateExplorerState],
  );

  return {
    workspaceStateKey,
    requestDirectoryListing,
    requestFilePreview,
    invalidateDirectoryListings,
    requestFileDownloadToken,
    requestFileBytes,
    selectExplorerEntry,
  };
}
