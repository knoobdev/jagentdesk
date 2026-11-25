import type {
  BuiltinBackgroundService,
  BuiltinCoreServices,
} from "../../../packages/server/src/server/plugins/builtin/host-api.js";

/**
 * Turning SSH servers off closes the shared pool and its listeners; turning it on reloads the
 * stores and reopens the forwards that were active. Saved servers, keys and rules stay on disk.
 */
export function createSshLifecycle(services: BuiltinCoreServices): BuiltinBackgroundService {
  const suspendedForwardingRules = new Set<string>();
  return {
    async start() {
      const ssh = services.ssh;
      if (!ssh) return;
      await ssh.initialize();
      const forwarding = ssh.modules?.forwarding;
      if (forwarding) {
        await Promise.all([...suspendedForwardingRules].map((id) => forwarding.start(id)));
      }
      suspendedForwardingRules.clear();
    },
    async stop() {
      const ssh = services.ssh;
      if (!ssh) return;
      // Stop dependents before closing the shared SSH pool. Keep module event wiring intact.
      await services.beforeSshStop?.();
      const modules = ssh.modules;
      if (modules) {
        for (const state of modules.forwarding.list().states) {
          if (state.status === "active") suspendedForwardingRules.add(state.ruleId);
        }
        await modules.forwarding.dispose();
        await modules.docker.stopAll();
        await modules.remoteDb.closeAll();
      }
      ssh.dispose();
    },
    idle() {
      services.ssh?.dispose();
    },
  };
}
