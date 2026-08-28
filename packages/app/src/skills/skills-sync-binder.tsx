import { useEffect } from "react";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { bindSkillsSync, unbindSkillsSync } from "@/stores/skills-store";

/**
 * Binds the global skills cache to the active host's daemon while a host route is
 * mounted, so every skills surface (the Skills screen, the composer picker, the
 * in-conversation train bar) reads the daemon-owned list. Renders nothing.
 */
export function SkillsSyncBinder({ serverId }: { serverId: string }): null {
  const client = useHostRuntimeClient(serverId);
  useEffect(() => {
    if (!client) {
      return;
    }
    bindSkillsSync(client, serverId);
    return () => {
      unbindSkillsSync();
    };
  }, [client, serverId]);
  return null;
}
