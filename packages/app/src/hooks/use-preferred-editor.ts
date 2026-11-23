import { useMemo } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

type EditorTargetId = string;

const PREFERRED_EDITOR_STORAGE_KEY = "@jagentdesk:preferred-editor";
const EDITOR_ID_SCHEMA = z.string().trim().min(1);

interface EditorPreferenceStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

interface ProjectEditorScope {
  serverId: string;
  projectId: string | null;
}

// Same boundary as the upstream validated storage: invalid persisted values
// never cross the read path, and cleanup failures must not surface either.
async function readValidatedString(
  storage: EditorPreferenceStorage,
  key: string,
  schema: z.ZodType<EditorTargetId>,
): Promise<EditorTargetId | null> {
  const raw = await storage.getItem(key);
  if (raw === null) return null;
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  try {
    await storage.removeItem(key);
  } catch {
    // Invalid persisted data must never cross the boundary, even when cleanup fails.
  }
  return null;
}

export function createPreferredEditorPreference({
  scope,
  queryClient,
  storage,
}: {
  scope: ProjectEditorScope;
  queryClient: QueryClient;
  storage: EditorPreferenceStorage;
}) {
  const queryKey = ["preferred-editor", scope.serverId, scope.projectId];
  const storageKey = `${PREFERRED_EDITOR_STORAGE_KEY}:${JSON.stringify([scope.serverId, scope.projectId])}`;
  async function load() {
    if (scope.projectId === null) return null;
    const projectEditor = await readValidatedString(storage, storageKey, EDITOR_ID_SCHEMA);
    if (projectEditor !== null) return projectEditor;
    return readValidatedString(storage, PREFERRED_EDITOR_STORAGE_KEY, EDITOR_ID_SCHEMA);
  }
  return {
    queryOptions: {
      queryKey,
      queryFn: load,
      enabled: scope.projectId !== null,
      staleTime: Infinity,
      gcTime: Infinity,
    },
    async update(editorId: EditorTargetId | null) {
      if (scope.projectId === null) return;
      if (editorId) {
        await storage.setItem(storageKey, editorId);
      } else {
        await storage.removeItem(storageKey);
      }
      queryClient.setQueryData(queryKey, await load());
    },
  };
}

export function resolvePreferredEditorId(
  availableEditorIds: readonly EditorTargetId[],
  storedEditorId: EditorTargetId | null | undefined,
): EditorTargetId | null {
  if (storedEditorId === undefined) {
    return null;
  }
  if (
    storedEditorId &&
    availableEditorIds.some((availableEditorId) => availableEditorId === storedEditorId)
  ) {
    return storedEditorId;
  }
  return availableEditorIds[0] ?? null;
}

export function usePreferredEditor(scope: ProjectEditorScope) {
  const queryClient = useQueryClient();
  const { serverId, projectId } = scope;
  const preference = useMemo(
    () =>
      createPreferredEditorPreference({
        scope: { serverId, projectId },
        queryClient,
        storage: AsyncStorage,
      }),
    [queryClient, serverId, projectId],
  );
  const { data, isPending } = useQuery(preference.queryOptions);

  const isLoading = projectId !== null && isPending;
  return {
    preferredEditorId: isLoading ? undefined : (data ?? null),
    isLoading,
    updatePreferredEditor: preference.update,
  };
}
