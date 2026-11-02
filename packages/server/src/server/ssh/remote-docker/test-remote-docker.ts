import { execCommand } from "../../../utils/spawn.js";
import { connectTestClient } from "../environment/test-sshd.js";

// Administration of the test sshd container (see environment/test-sshd.ts), done from outside
// the SSH session: reloading sshd drops every live session, including the one asking for it.
const CONTAINER = process.env.JAD_ENVDOCKER_SSHD_NAME ?? "jad-sshd-envdocker";
const SSHD_CONFIG = "/config/sshd/sshd_config";

export async function asRoot(command: string): Promise<string> {
  const result = await execCommand("docker", ["exec", CONTAINER, "sh", "-c", command], {
    timeout: 30_000,
  });
  return result.stdout.trim();
}

async function waitForSshd(): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      (await connectTestClient()).end();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

/** Sets (value) or removes (null) one sshd_config directive and reloads sshd. */
export async function setSshdOption(key: string, value: string | null): Promise<void> {
  const append = value === null ? "" : ` && echo "${key} ${value}" >> ${SSHD_CONFIG}`;
  await asRoot(`sed -i "/^${key} /d" ${SSHD_CONFIG}${append} && kill -HUP $(cat /config/sshd.pid)`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await waitForSshd();
}

/**
 * Lets jad open the mounted Docker socket (root:root 0660) or not. This image runs sshd as jad
 * itself, so sessions inherit sshd's groups: the service restarts to pick the change up.
 */
export async function setDockerSocketAccess(granted: boolean): Promise<void> {
  const change = granted ? "addgroup jad root" : "delgroup jad root 2>/dev/null; true";
  await asRoot(`${change}; s6-svc -r /run/service/svc-openssh-server`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await waitForSshd();
}
