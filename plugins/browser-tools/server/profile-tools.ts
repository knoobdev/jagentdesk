import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import nodePath from "node:path";
import { z } from "zod";
import {
  generateFingerprintProfile,
  type BrowserFingerprintProfile,
  type FingerprintOs,
} from "@jagentdesk/protocol/browser-automation/fingerprint-profile";
import {
  expandUserPath,
  type BrowserFingerprintProfileStore,
  type RegisterBuiltinTool,
} from "../../../packages/server/src/server/plugins/builtin/host-api.js";

// The agentic browser's anti-detect fingerprint profiles (daemon config `browserTools.profiles`).
export function registerBrowserProfileTools(
  registerTool: RegisterBuiltinTool,
  store: BrowserFingerprintProfileStore,
): void {
  const summarize = (profile: BrowserFingerprintProfile) => ({
    id: profile.id,
    name: profile.name,
    os: profile.os,
    userAgent: profile.userAgent,
    timezone: profile.timezone,
    locale: profile.locale,
    matchIpLocation: profile.geoFromIp !== false,
    hasProxy: profile.proxy !== null,
    webrtcPolicy: profile.webrtcPolicy,
    extensions: profile.extensions.length,
    stealthEnabled: profile.stealthEnabled,
    active: profile.id === store.activeId(),
  });

  registerTool(
    "browser_profile_list",
    {
      title: "List browser fingerprint profiles",
      description:
        "List the agentic browser's anti-detect fingerprint profiles and which one is active. Use before browser_profile_use to pick one. Auto-approved.",
      inputSchema: {},
    },
    async () => {
      const profiles = store.list().map(summarize);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { count: profiles.length, activeProfileId: store.activeId(), profiles },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  registerTool(
    "browser_profile_create",
    {
      title: "Create browser fingerprint profile",
      description:
        "Create a coherent anti-detect fingerprint profile for the agentic browser (a consistent device identity: User-Agent, UA Client Hints, WebGL, timezone, screen, seeded canvas/audio noise). Optionally attach a proxy (the ONLY way to change the observed IP — no proxy means the real IP), Chromium extensions (absolute unpacked dirs you can author first), and custom init scripts (JS injected before page scripts). Set activate=true to make it the active profile immediately. For identities strict checkers (PixelScan, iphey) accept: use the OS of the machine running the browser (macOS on a Mac) — its real GPU is then reported, while another OS must claim a GPU the hardware cannot back; timezone, locale and languages follow the exit IP's location by default (matchIpLocation). Auto-approved.",
      inputSchema: {
        name: z
          .string()
          .trim()
          .min(1)
          .max(60)
          .optional()
          .describe("Label shown in the profile list."),
        os: z
          .enum(["windows", "macos", "linux"])
          .optional()
          .describe("Device OS family the identity mimics. Defaults to windows."),
        timezone: z
          .string()
          .trim()
          .optional()
          .describe("IANA timezone, e.g. America/New_York. Setting it turns off matchIpLocation."),
        locale: z.string().trim().optional().describe("BCP-47 locale, e.g. en-US."),
        matchIpLocation: z
          .boolean()
          .optional()
          .describe(
            "Take timezone, locale and languages from the location of the exit IP (through the proxy) each time the profile is applied. Default true unless timezone is given.",
          ),
        languages: z
          .array(z.string().trim().min(1))
          .optional()
          .describe("navigator.languages list."),
        proxyServer: z
          .string()
          .trim()
          .optional()
          .describe("Proxy URL scheme://host:port (http/https/socks5). Required to change the IP."),
        proxyUsername: z.string().optional(),
        proxyPassword: z.string().optional(),
        webrtcPolicy: z
          .enum(["default", "force-proxy", "disable"])
          .optional()
          .describe("force-proxy closes the WebRTC STUN IP leak behind a proxy."),
        extensions: z
          .array(z.string().trim().min(1))
          .optional()
          .describe("Absolute paths to unpacked Chromium extension directories."),
        initScripts: z
          .array(z.string().min(1))
          .optional()
          .describe("Custom JS injected into every page before its own scripts run."),
        stealthEnabled: z
          .boolean()
          .optional()
          .describe(
            "Apply fingerprint spoofing. Default true. False = real identity + proxy/extensions only.",
          ),
        activate: z
          .boolean()
          .optional()
          .describe("Make this the active profile now. Default true."),
      },
    },
    async (input: {
      name?: string;
      os?: FingerprintOs;
      timezone?: string;
      matchIpLocation?: boolean;
      locale?: string;
      languages?: string[];
      proxyServer?: string;
      proxyUsername?: string;
      proxyPassword?: string;
      webrtcPolicy?: "default" | "force-proxy" | "disable";
      extensions?: string[];
      initScripts?: string[];
      stealthEnabled?: boolean;
      activate?: boolean;
    }) => {
      const id = `bfp_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const proxy = input.proxyServer
        ? {
            server: input.proxyServer.trim(),
            ...(input.proxyUsername ? { username: input.proxyUsername } : {}),
            ...(input.proxyPassword ? { password: input.proxyPassword } : {}),
          }
        : null;
      const base = generateFingerprintProfile({
        id,
        nowMs: Date.now(),
        ...(input.name ? { name: input.name } : {}),
        ...(input.os ? { os: input.os } : {}),
        ...(input.timezone ? { timezone: input.timezone } : {}),
        ...(input.matchIpLocation !== undefined ? { geoFromIp: input.matchIpLocation } : {}),
        ...(input.locale ? { locale: input.locale } : {}),
        ...(input.languages ? { languages: input.languages } : {}),
        proxy,
        ...(input.webrtcPolicy ? { webrtcPolicy: input.webrtcPolicy } : {}),
      });
      const profile: BrowserFingerprintProfile = {
        ...base,
        extensions: input.extensions ?? base.extensions,
        initScripts: input.initScripts ?? base.initScripts,
        stealthEnabled: input.stealthEnabled ?? base.stealthEnabled,
      };
      store.save(profile);
      if (input.activate !== false) {
        store.select(profile.id);
      }
      return {
        content: [{ type: "text", text: JSON.stringify(summarize(profile), null, 2) }],
      };
    },
  );

  registerTool(
    "browser_profile_use",
    {
      title: "Select active browser fingerprint profile",
      description:
        "Set the active anti-detect fingerprint profile applied to new browser tabs (pass an id from browser_profile_list), or pass null to use the host's real identity. Takes effect on the next tab/navigation. Auto-approved.",
      inputSchema: {
        id: z
          .string()
          .trim()
          .nullable()
          .describe("Profile id to activate, or null to clear (use the real browser identity)."),
      },
    },
    async (input: { id: string | null }) => {
      const targetId = input.id === null ? null : input.id.trim();
      if (targetId !== null && !store.list().some((profile) => profile.id === targetId)) {
        return {
          content: [{ type: "text", text: `No fingerprint profile with id ${targetId}` }],
          isError: true,
        };
      }
      store.select(targetId);
      return {
        content: [{ type: "text", text: JSON.stringify({ activeProfileId: targetId }, null, 2) }],
      };
    },
  );

  registerTool(
    "browser_scaffold_extension",
    {
      title: "Scaffold a Chromium extension for the agentic browser",
      description:
        "Write a working, unpacked Manifest V3 Chromium extension skeleton to a directory (manifest.json + content.js) so you can then EDIT the content script to do what you need and load it with browser_load_extension. The template's content script runs in its own world (so it works even where the page CSP blocks injected scripts), mirrors signals onto a `data-jad-*` attribute on <html> that you can read with browser_snapshot/browser_evaluate, and listens for commands you write back — the basis for real-time, event-driven page monitoring/automation instead of polling. After scaffolding, edit content.js, then call browser_load_extension with the same path. Auto-approved.",
      inputSchema: {
        path: z
          .string()
          .trim()
          .min(1)
          .describe("Absolute directory to create the extension in (created if missing)."),
        name: z.string().trim().min(1).max(60).optional().describe("Extension name."),
        matches: z
          .array(z.string().trim().min(1))
          .optional()
          .describe("URL match patterns for the content script. Defaults to ['<all_urls>']."),
      },
    },
    async (input: { path: string; name?: string; matches?: string[] }) => {
      const dir = expandUserPath(input.path.trim());
      const name = input.name?.trim() || "JAgentDesk Agent Extension";
      const matches = input.matches && input.matches.length > 0 ? input.matches : ["<all_urls>"];
      const manifest = {
        manifest_version: 3,
        name,
        version: "1.0.0",
        description: "Authored by a JAgentDesk agent for the agentic browser.",
        content_scripts: [
          { matches, js: ["content.js"], run_at: "document_idle", all_frames: false },
        ],
        host_permissions: matches,
        permissions: [],
      };
      const contentJs = `// Content script — runs in an isolated world, so it works even when the page's
// CSP blocks injected page scripts. Edit the logic below for your task.
(() => {
  const root = document.documentElement;
  // Push a signal the agent can read via browser_snapshot / browser_evaluate:
  //   browser_evaluate: document.documentElement.getAttribute('data-jad-signal')
  const emit = (value) => {
    try { root.setAttribute('data-jad-signal', typeof value === 'string' ? value : JSON.stringify(value)); } catch (e) {}
  };
  // Example: report the page title once, then on every DOM mutation (real-time).
  emit({ type: 'ready', title: document.title, url: location.href, at: Date.now() });
  const observer = new MutationObserver(() => {
    emit({ type: 'mutation', title: document.title, url: location.href, at: Date.now() });
  });
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  // Accept commands the agent writes back to a data attribute, e.g. via CDP/DOM:
  //   root.setAttribute('data-jad-command', JSON.stringify({ action: 'click', selector: '#x' }))
  new MutationObserver(() => {
    const raw = root.getAttribute('data-jad-command');
    if (!raw) return;
    root.removeAttribute('data-jad-command');
    try {
      const cmd = JSON.parse(raw);
      if (cmd && cmd.action === 'click' && cmd.selector) {
        document.querySelector(cmd.selector)?.click();
        emit({ type: 'command-done', action: 'click', selector: cmd.selector, at: Date.now() });
      }
      // Add more command handlers here.
    } catch (e) { emit({ type: 'command-error', error: String(e && e.message) }); }
  }).observe(root, { attributes: true, attributeFilter: ['data-jad-command'] });
})();
`;
      try {
        await mkdir(dir, { recursive: true });
        await writeFile(
          nodePath.join(dir, "manifest.json"),
          `${JSON.stringify(manifest, null, 2)}\n`,
        );
        await writeFile(nodePath.join(dir, "content.js"), contentJs);
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to scaffold extension: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                path: dir,
                files: ["manifest.json", "content.js"],
                next: "Edit content.js for your task, then call browser_load_extension with this path.",
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  registerTool(
    "browser_load_extension",
    {
      title: "Load a Chromium extension into the agentic browser",
      description:
        "Load an unpacked Chromium extension into the agentic browser. YOU CAN AUTHOR THE EXTENSION YOURSELF: use your file tools to write a directory containing a manifest.json (manifest_version 3) plus content/background scripts, then call this with that absolute directory. This is the way to do things the fixed browser_* tools can't — a content script runs in its own world, so it works on pages whose CSP blocks injected page scripts, can watch the DOM/network continuously and push events, and can relay signals back to the page. It attaches to the active fingerprint profile (creating one if none is active) and loads on the next tab; reload or open a tab afterwards. Prefer this (event-driven) over a cron/polling loop for real-time page monitoring. Auto-approved.",
      inputSchema: {
        path: z
          .string()
          .trim()
          .min(1)
          .describe("Absolute path to the unpacked extension directory (contains manifest.json)."),
      },
    },
    async (input: { path: string }) => {
      const path = input.path.trim();
      const activeId = store.activeId();
      const current = activeId
        ? (store.list().find((profile) => profile.id === activeId) ?? null)
        : null;
      const base =
        current ??
        generateFingerprintProfile({
          id: `bfp_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
          nowMs: Date.now(),
          name: "Browser (extensions)",
        });
      const extensions = base.extensions.includes(path)
        ? base.extensions
        : [...base.extensions, path];
      const profile: BrowserFingerprintProfile = {
        ...base,
        extensions,
        updatedAtMs: Date.now(),
      };
      store.save(profile);
      store.select(profile.id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                loaded: path,
                profileId: profile.id,
                extensions: profile.extensions,
                note: "Open browser tabs are reloaded automatically so the extension's content scripts inject; open a new tab if none exists yet.",
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  registerTool(
    "browser_profile_update",
    {
      title: "Update a browser fingerprint profile",
      description:
        "Change fields on an existing anti-detect fingerprint profile by id (from browser_profile_list). Only the fields you pass are changed. Use this to attach/rotate a proxy (the only way to change the observed IP), adjust timezone/locale to match the proxy geo, add custom init scripts or extensions, toggle spoofing, or set the WebRTC leak policy. Takes effect on the next tab/navigation. Auto-approved.",
      inputSchema: {
        id: z.string().trim().min(1).describe("Profile id to update."),
        name: z.string().trim().min(1).max(60).optional(),
        timezone: z
          .string()
          .trim()
          .optional()
          .describe("IANA timezone. Setting it turns off matchIpLocation."),
        matchIpLocation: z
          .boolean()
          .optional()
          .describe("Take timezone, locale and languages from the exit IP's location."),
        locale: z.string().trim().optional(),
        languages: z.array(z.string().trim().min(1)).optional(),
        proxyServer: z
          .string()
          .trim()
          .nullable()
          .optional()
          .describe("Proxy URL scheme://host:port, or null to remove the proxy."),
        proxyUsername: z.string().optional(),
        proxyPassword: z.string().optional(),
        webrtcPolicy: z.enum(["default", "force-proxy", "disable"]).optional(),
        extensions: z
          .array(z.string().trim().min(1))
          .optional()
          .describe("Replaces the profile's extension dir list."),
        initScripts: z
          .array(z.string().min(1))
          .optional()
          .describe(
            "Replaces the profile's custom init scripts (JS injected before page scripts).",
          ),
        stealthEnabled: z.boolean().optional(),
      },
    },
    async (input: {
      id: string;
      name?: string;
      timezone?: string;
      matchIpLocation?: boolean;
      locale?: string;
      languages?: string[];
      proxyServer?: string | null;
      proxyUsername?: string;
      proxyPassword?: string;
      webrtcPolicy?: "default" | "force-proxy" | "disable";
      extensions?: string[];
      initScripts?: string[];
      stealthEnabled?: boolean;
    }) => {
      const current = store.list().find((profile) => profile.id === input.id.trim());
      if (!current) {
        return {
          content: [{ type: "text", text: `No fingerprint profile with id ${input.id.trim()}` }],
          isError: true,
        };
      }
      let proxy: BrowserFingerprintProfile["proxy"] = current.proxy;
      if (input.proxyServer === null) proxy = null;
      else if (input.proxyServer !== undefined)
        proxy = {
          server: input.proxyServer.trim(),
          ...(input.proxyUsername ? { username: input.proxyUsername } : {}),
          ...(input.proxyPassword ? { password: input.proxyPassword } : {}),
        };
      const profile: BrowserFingerprintProfile = {
        ...current,
        ...(input.name ? { name: input.name } : {}),
        ...(input.timezone ? { timezone: input.timezone, geoFromIp: false } : {}),
        ...(input.matchIpLocation !== undefined ? { geoFromIp: input.matchIpLocation } : {}),
        ...(input.locale ? { locale: input.locale } : {}),
        ...(input.languages ? { languages: input.languages } : {}),
        proxy,
        ...(input.webrtcPolicy ? { webrtcPolicy: input.webrtcPolicy } : {}),
        ...(input.extensions ? { extensions: input.extensions } : {}),
        ...(input.initScripts ? { initScripts: input.initScripts } : {}),
        ...(input.stealthEnabled !== undefined ? { stealthEnabled: input.stealthEnabled } : {}),
        updatedAtMs: Date.now(),
      };
      store.save(profile);
      return {
        content: [{ type: "text", text: JSON.stringify(summarize(profile), null, 2) }],
      };
    },
  );

  registerTool(
    "browser_profile_delete",
    {
      title: "Delete a browser fingerprint profile",
      description:
        "Delete an anti-detect fingerprint profile by id (from browser_profile_list). If it was the active profile, the browser reverts to the host's real identity. Auto-approved.",
      inputSchema: {
        id: z.string().trim().min(1).describe("Profile id to delete."),
      },
    },
    async (input: { id: string }) => {
      const id = input.id.trim();
      if (!store.list().some((profile) => profile.id === id)) {
        return {
          content: [{ type: "text", text: `No fingerprint profile with id ${id}` }],
          isError: true,
        };
      }
      store.remove(id);
      return {
        content: [{ type: "text", text: JSON.stringify({ deleted: id }, null, 2) }],
      };
    },
  );
}
