import type {
  NavigationAction,
  NavigationContainerRefWithCurrent,
} from "expo-router/react-navigation";
import { router, type Href } from "expo-router";
import {
  decodeWorkspaceIdFromPathSegment,
  encodeWorkspaceIdForPathSegment,
  getHostWorkspaceOpenParamFromPathname,
  parseHostWorkspaceRouteFromPathname,
} from "@/utils/host-routes";

const ROOT_HOST_ROUTE_NAME = "h/[serverId]";
const HOST_WORKSPACE_ROUTE_NAME = "workspace/[workspaceId]/index";

interface NavigateToHostWorkspaceRouteDeps {
  dismissTo(route: string): void;
}

const defaultNavigateToHostWorkspaceRouteDeps: NavigateToHostWorkspaceRouteDeps = {
  dismissTo: (route) => router.dismissTo(route as Href),
};

let rootNavigationRef: NavigationContainerRefWithCurrent<ReactNavigation.RootParamList> | null =
  null;

export function registerWorkspaceRouteNavigationRef(
  ref: NavigationContainerRefWithCurrent<ReactNavigation.RootParamList>,
): () => void {
  rootNavigationRef = ref;
  return () => {
    if (rootNavigationRef === ref) {
      rootNavigationRef = null;
    }
  };
}

/**
 * The workspace on screen right now, read from the focused route, or null on any other screen
 * (Settings, New workspace, ...). Unlike a component's last render, it stays correct for work that
 * finishes after the screen that started it is gone.
 */
export function getFocusedWorkspaceSelection(): { serverId: string; workspaceId: string } | null {
  // Typed routes narrow the container's route to `never`; this only reads name and params.
  const route = rootNavigationRef?.current?.getCurrentRoute() as
    | { name: string; params?: { serverId?: unknown; workspaceId?: unknown } }
    | undefined;
  if (route?.name !== HOST_WORKSPACE_ROUTE_NAME) {
    return null;
  }
  const params = route.params;
  if (typeof params?.serverId !== "string" || typeof params.workspaceId !== "string") {
    return null;
  }
  const workspaceId = decodeWorkspaceIdFromPathSegment(params.workspaceId);
  return workspaceId ? { serverId: params.serverId, workspaceId } : null;
}

function findStackKeyWithMountedRouteName(state: unknown, routeName: string): string | null {
  if (!state || typeof state !== "object") {
    return null;
  }

  const candidate = state as {
    key?: unknown;
    routes?: unknown;
  };

  if (!Array.isArray(candidate.routes)) {
    return null;
  }

  if (
    typeof candidate.key === "string" &&
    candidate.routes.some(
      (route) =>
        !!route && typeof route === "object" && (route as { name?: unknown }).name === routeName,
    )
  ) {
    return candidate.key;
  }

  for (const route of candidate.routes) {
    if (!route || typeof route !== "object") {
      continue;
    }
    const childKey = findStackKeyWithMountedRouteName(
      (route as { state?: unknown }).state,
      routeName,
    );
    if (childKey) {
      return childKey;
    }
  }

  return null;
}

function dispatchHostWorkspacePopTo(route: string): boolean {
  const selection = parseHostWorkspaceRouteFromPathname(route);
  const navigation = rootNavigationRef?.current;
  if (!selection || !navigation?.isReady()) {
    return false;
  }

  const rootState = navigation.getRootState();
  const target = findStackKeyWithMountedRouteName(rootState, ROOT_HOST_ROUTE_NAME);
  if (!target) {
    return false;
  }
  const open = getHostWorkspaceOpenParamFromPathname(route);

  const action: NavigationAction = {
    type: "POP_TO",
    target,
    payload: {
      name: ROOT_HOST_ROUTE_NAME,
      params: {
        serverId: selection.serverId,
        screen: HOST_WORKSPACE_ROUTE_NAME,
        params: {
          serverId: selection.serverId,
          workspaceId: encodeWorkspaceIdForPathSegment(selection.workspaceId),
          ...(open ? { open } : {}),
        },
        // React Navigation consumes this nested hint when resolving the host child screen.
        // The browser-route canonicalizer strips the resulting ?pop=true URL artifact.
        // Removing it lets repeated /new -> workspace hops append hidden deck entries.
        pop: true,
      },
    },
  };
  navigation.dispatch(action);
  return true;
}

export function navigateToHostWorkspaceRoute(
  route: string,
  deps: NavigateToHostWorkspaceRouteDeps = defaultNavigateToHostWorkspaceRouteDeps,
): void {
  if (dispatchHostWorkspacePopTo(route)) {
    return;
  }

  deps.dismissTo(route);
}
