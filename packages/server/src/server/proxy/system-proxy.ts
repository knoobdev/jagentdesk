import { execCommand } from "../../utils/spawn.js";

// macOS system HTTP/HTTPS proxy control (via `networksetup`). iOS Simulators use the Mac's network
// stack and honor the system proxy — and, unlike NSURLSession's per-app connectionProxyDictionary
// (which the simulator ignores), the system proxy reliably routes simulator app traffic through the
// Workbench listener. We snapshot the prior state on start and always restore it on stop, so the
// user's machine is left exactly as it was. HTTPS interception additionally needs the CA trusted
// (in the simulator via simctl; the Mac's own HTTPS is left direct unless the user opts in).

export interface SystemProxyState {
  service: string;
  webEnabled: boolean;
  webHost: string;
  webPort: string;
  secureEnabled: boolean;
  secureHost: string;
  securePort: string;
}

// The first active (non-disabled) network service, e.g. "Wi-Fi" — where the proxy must be set.
export async function primaryNetworkService(): Promise<string | null> {
  try {
    const { stdout } = await execCommand("networksetup", ["-listallnetworkservices"], {
      timeout: 10_000,
    });
    const lines = stdout.split("\n").slice(1); // first line is a disclaimer
    for (const line of lines) {
      const name = line.trim();
      if (!name || name.startsWith("*")) continue; // "*" prefix = disabled
      return name;
    }
  } catch {
    /* networksetup unavailable */
  }
  return null;
}

async function readProxy(
  service: string,
  kind: "web" | "secure",
): Promise<{ enabled: boolean; host: string; port: string }> {
  const cmd = kind === "web" ? "-getwebproxy" : "-getsecurewebproxy";
  const { stdout } = await execCommand("networksetup", [cmd, service], { timeout: 10_000 });
  const enabled = /Enabled:\s*Yes/i.test(stdout);
  const host = /Server:\s*(.*)/i.exec(stdout)?.[1]?.trim() ?? "";
  const port = /Port:\s*(.*)/i.exec(stdout)?.[1]?.trim() ?? "";
  return { enabled, host, port };
}

export async function snapshotSystemProxy(service: string): Promise<SystemProxyState> {
  const web = await readProxy(service, "web");
  const secure = await readProxy(service, "secure");
  return {
    service,
    webEnabled: web.enabled,
    webHost: web.host,
    webPort: web.port,
    secureEnabled: secure.enabled,
    secureHost: secure.host,
    securePort: secure.port,
  };
}

// Point the system proxy at the listener. `https` also routes HTTPS (needs the CA trusted); default
// is HTTP-only so the Mac's own HTTPS keeps working while capturing simulator HTTP traffic.
export async function enableSystemProxy(
  service: string,
  host: string,
  port: number,
  options?: { https?: boolean },
): Promise<void> {
  await execCommand("networksetup", ["-setwebproxy", service, host, String(port)], {
    timeout: 10_000,
  });
  await execCommand("networksetup", ["-setwebproxystate", service, "on"], { timeout: 10_000 });
  if (options?.https) {
    await execCommand("networksetup", ["-setsecurewebproxy", service, host, String(port)], {
      timeout: 10_000,
    });
    await execCommand("networksetup", ["-setsecurewebproxystate", service, "on"], {
      timeout: 10_000,
    });
  }
}

// Restore the exact prior state (host/port and on/off) captured in the snapshot.
export async function restoreSystemProxy(state: SystemProxyState): Promise<void> {
  const s = state.service;
  if (state.webEnabled && state.webHost) {
    await execCommand("networksetup", ["-setwebproxy", s, state.webHost, state.webPort || "0"], {
      timeout: 10_000,
    }).catch(() => {});
    await execCommand("networksetup", ["-setwebproxystate", s, "on"], { timeout: 10_000 }).catch(
      () => {},
    );
  } else {
    await execCommand("networksetup", ["-setwebproxystate", s, "off"], { timeout: 10_000 }).catch(
      () => {},
    );
  }
  if (state.secureEnabled && state.secureHost) {
    await execCommand(
      "networksetup",
      ["-setsecurewebproxy", s, state.secureHost, state.securePort || "0"],
      { timeout: 10_000 },
    ).catch(() => {});
    await execCommand("networksetup", ["-setsecurewebproxystate", s, "on"], {
      timeout: 10_000,
    }).catch(() => {});
  } else {
    await execCommand("networksetup", ["-setsecurewebproxystate", s, "off"], {
      timeout: 10_000,
    }).catch(() => {});
  }
}
