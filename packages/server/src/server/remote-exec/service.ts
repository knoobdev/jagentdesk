// TEMP(remote-exec-engine): placeholder until C2's engine lands. The coordinator replaces this
// file with C2's `createRemoteExecService` at merge; every other module only relies on the
// `RemoteExecService` contract in ./types.js.
import type { RemoteExecDeps, RemoteExecService } from "./types.js";

export function createRemoteExecService(deps: RemoteExecDeps): RemoteExecService {
  void deps;
  throw new Error("remote-exec engine not merged");
}
