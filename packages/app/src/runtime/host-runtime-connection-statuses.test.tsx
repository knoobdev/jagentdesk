// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * The app ships through the React Compiler (`reactCompiler: true`), which infers each memo's
 * dependencies from what the code reads. Vitest compiles with esbuild and never runs it, so a
 * hook can pass here and still be wrong in the app. This test compiles the real
 * `useHostRuntimeConnectionStatuses` source with the same compiler the app build uses and drives
 * it with a store whose host comes online after the first render.
 *
 * The reported failure: after a renderer reload the sidebar Usage summary stayed empty. Its host
 * list was built while the host was still connecting; the compiled hook memoized the statuses on
 * `serverIds` alone (a `void version;` read was dropped), so the host never read as online and the
 * summary never chose a host to fetch.
 */

const nodeRequire = createRequire(import.meta.url);
const babel = nodeRequire("@babel/core") as typeof import("@babel/core");

type Status = "connecting" | "online" | "offline";

interface FakeStore {
  statuses: Map<string, Status>;
  listeners: Set<() => void>;
  version: number;
  getSnapshot(serverId: string): { connectionStatus: Status } | null;
  getVersion(): number;
  subscribeAll(listener: () => void): () => void;
  setStatus(serverId: string, status: Status): void;
}

function createFakeStore(initial: Record<string, Status>): FakeStore {
  const store: FakeStore = {
    statuses: new Map(Object.entries(initial)),
    listeners: new Set(),
    version: 0,
    getSnapshot: (serverId) => {
      const status = store.statuses.get(serverId);
      return status ? { connectionStatus: status } : null;
    },
    getVersion: () => store.version,
    subscribeAll: (listener) => {
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    },
    setStatus: (serverId, status) => {
      store.statuses.set(serverId, status);
      store.version += 1;
      for (const listener of store.listeners) listener();
    },
  };
  return store;
}

/** The hook's own source, cut out of host-runtime.ts so nothing else from the runtime loads. */
function readHookSource(): string {
  const file = readFileSync(path.join(__dirname, "host-runtime.ts"), "utf8");
  const start = file.indexOf("export function useHostRuntimeConnectionStatuses(");
  if (start < 0) throw new Error("useHostRuntimeConnectionStatuses not found");
  const end = file.indexOf("\n}\n", start);
  return file.slice(start, end + 3);
}

/** Compiles the hook as the app build does and returns it bound to `store`. */
function compileHook(
  store: FakeStore,
): (serverIds: readonly string[]) => ReadonlyMap<string, Status> {
  const source = `
import { useMemo, useSyncExternalStore } from "react";
type HostRuntimeConnectionStatus = "connecting" | "online" | "offline";
declare const __store: any;
function getHostRuntimeStore() { return __store; }
${readHookSource()}
`;
  const result = babel.transformSync(source, {
    filename: "host-runtime-connection-statuses.tsx",
    babelrc: false,
    configFile: false,
    presets: [
      [nodeRequire.resolve("@babel/preset-typescript"), { isTSX: true, allExtensions: true }],
    ],
    plugins: [
      [
        nodeRequire.resolve("babel-plugin-react-compiler"),
        { target: "19", panicThreshold: "none" },
      ],
      nodeRequire.resolve("@babel/plugin-transform-modules-commonjs"),
    ],
  });
  const code = result?.code;
  if (!code) throw new Error("compilation produced no code");
  expect(code).toContain("react/compiler-runtime");
  const moduleExports: Record<string, unknown> = {};
  const run = new Function("require", "exports", "__store", code);
  run(nodeRequire, moduleExports, store);
  return moduleExports.useHostRuntimeConnectionStatuses as (
    serverIds: readonly string[],
  ) => ReadonlyMap<string, Status>;
}

describe("useHostRuntimeConnectionStatuses under the React Compiler", () => {
  it("reports a host that comes online after the first render, with the same host list", () => {
    const store = createFakeStore({ srv_local: "connecting" });
    const useStatuses = compileHook(store);
    const serverIds = ["srv_local"];
    const { result } = renderHook(() => useStatuses(serverIds));
    expect(result.current.get("srv_local")).toBe("connecting");

    act(() => store.setStatus("srv_local", "online"));
    expect(result.current.get("srv_local")).toBe("online");

    act(() => store.setStatus("srv_local", "offline"));
    expect(result.current.get("srv_local")).toBe("offline");
  });

  it("keeps the same map while nothing it reports changed", () => {
    const store = createFakeStore({ srv_a: "online", srv_b: "connecting" });
    const useStatuses = compileHook(store);
    const serverIds = ["srv_a", "srv_b"];
    const { result } = renderHook(() => useStatuses(serverIds));
    const first = result.current;
    // Another host's tick bumps the store but changes nothing these hosts report.
    act(() => store.setStatus("srv_other", "online"));
    expect(result.current).toBe(first);
    act(() => store.setStatus("srv_b", "online"));
    expect(result.current.get("srv_b")).toBe("online");
  });
});
