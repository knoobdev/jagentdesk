export interface SshDockerTarget {
  /** Saved SSH server whose Docker the cockpit shows. */
  serverId: string;
  /** `unix://…` forwarded socket on the daemon (ssh.docker.attach), for the exec terminal. */
  dockerHost: string;
}

/**
 * The existing Docker cockpit, pointed at an SSH server (spec 25.10): every `docker*` request
 * carries the server's id, and the exec terminal's `docker` argv targets the forwarded socket.
 * Everything else passes through untouched.
 */
export function withSshDocker<T extends object>(client: T, target: SshDockerTarget): T {
  return new Proxy(client, {
    get(base, prop, receiver) {
      const value: unknown = Reflect.get(base, prop, receiver);
      if (typeof prop !== "string" || typeof value !== "function") return value;
      if (prop.startsWith("docker")) {
        return (options: unknown, ...rest: unknown[]) => {
          const withServer =
            typeof options === "object" && options !== null
              ? { ...options, serverId: target.serverId }
              : options;
          return value.call(base, withServer, ...rest);
        };
      }
      if (prop === "createTerminal") {
        return (...args: unknown[]) => {
          const options = args[3];
          if (typeof options === "object" && options !== null && "command" in options) {
            const spawn = options as { command?: string; args?: string[] };
            if (spawn.command === "docker") {
              args[3] = { ...spawn, args: ["--host", target.dockerHost, ...(spawn.args ?? [])] };
            }
          }
          return value.apply(base, args);
        };
      }
      return value.bind(base);
    },
  });
}
