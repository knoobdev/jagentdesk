import { z } from "zod";
import type {
  BuiltinProvidedServices,
  JAgentDeskToolResult,
  RegisterBuiltinTool,
  StaticHostSupport,
} from "../../../packages/server/src/server/plugins/builtin/host-api.js";
import { fridaAvailability, installFrida, launchAndUnpin } from "./proxy/frida-control.js";
import { getSharedProxyService, installCaToSimulator } from "./proxy/proxy-service.js";

function textResult(text: string): JAgentDeskToolResult {
  return { content: [{ type: "text", text: text || "(ok)" }] };
}
function simErrorResult(err: unknown): JAgentDeskToolResult {
  const e = err as { stderr?: string; message?: string };
  return {
    content: [
      { type: "text", text: `simulator failed: ${(e.stderr || e.message || String(err)).trim()}` },
    ],
    isError: true,
  };
}

// Workbench (intercepting-proxy) tools — the agent drives the same capture sessions and store the
// human UI shows (getSharedProxyService is a daemon-wide singleton). The agent can tell which
// simulator a session is bound to via the `udid`/`bundleId` on each session and transaction.
export function registerProxyTools(params: {
  registerTool: RegisterBuiltinTool;
  support: StaticHostSupport;
  simulatorInstaller: BuiltinProvidedServices["devices.simulator-installer"] | undefined;
}): void {
  const { registerTool, support } = params;
  const svc = getSharedProxyService();
  // Spec 24.5: only offer capture modes this host can run.
  const captureModes = [
    "manual",
    ...(support.proxySystemCapture ? ["system"] : []),
    ...(support.iosSimulators ? ["frida"] : []),
  ] as [string, ...string[]];

  registerTool(
    "proxy_capture_start",
    {
      title: "Workbench: start capture",
      description: `Start an intercepting-proxy capture session and return its listener host:port. Modes on this host: ${captureModes.join(", ")}. mode='manual' points a client at the listener${support.proxySystemCapture ? "; 'system' captures through the macOS system proxy" : ""}${support.iosSimulators ? "; 'frida' binds to a simulator udid+bundleId" : ""}. Returns the session, whose udid tells which simulator it captures.`,
      inputSchema: {
        mode: z.enum(captureModes).optional(),
        udid: z.string().optional(),
        bundleId: z.string().optional(),
        label: z.string().optional(),
      },
    },
    async (input: {
      mode?: "manual" | "system" | "frida";
      udid?: string;
      bundleId?: string;
      label?: string;
    }) => {
      try {
        const session = await svc.captureStart({
          mode: input.mode ?? "manual",
          udid: input.udid,
          bundleId: input.bundleId,
          label: input.label,
        });
        return textResult(JSON.stringify(session, null, 2));
      } catch (err) {
        return simErrorResult(err);
      }
    },
  );

  registerTool(
    "proxy_capture_stop",
    {
      title: "Workbench: stop capture",
      description: "Stop a capture session by id.",
      inputSchema: { sessionId: z.string() },
    },
    async (input: { sessionId: string }) => {
      try {
        await svc.captureStop(input.sessionId);
        return textResult(`stopped ${input.sessionId}`);
      } catch (err) {
        return simErrorResult(err);
      }
    },
  );

  registerTool(
    "proxy_sessions_list",
    {
      title: "Workbench: list capture sessions",
      description:
        "List capture sessions (id, mode, state, listener, udid, bundleId, transactionCount). Auto-approved (read-only). Use udid/bundleId to see which simulator each session captures.",
      inputSchema: {},
    },
    async () => textResult(JSON.stringify(svc.sessionsList(), null, 2)),
  );

  registerTool(
    "proxy_history_query",
    {
      title: "Workbench: query HTTP history",
      description:
        "Query captured HTTP transactions. Filter by sessionId, host, method, status, or a free-text 'contains'. Auto-approved (read-only).",
      inputSchema: {
        sessionId: z.string().optional(),
        host: z.string().optional(),
        method: z.string().optional(),
        status: z.number().optional(),
        contains: z.string().optional(),
        limit: z.number().optional(),
      },
    },
    async (input: {
      sessionId?: string;
      host?: string;
      method?: string;
      status?: number;
      contains?: string;
      limit?: number;
    }) => {
      const rows = svc.historyQuery({
        sessionId: input.sessionId ?? null,
        host: input.host,
        method: input.method,
        status: input.status,
        contains: input.contains,
        limit: input.limit ?? 100,
      });
      return textResult(JSON.stringify(rows, null, 2));
    },
  );

  registerTool(
    "proxy_request_get",
    {
      title: "Workbench: get transaction",
      description:
        "Get the full request/response for a captured transaction id. Auto-approved (read-only).",
      inputSchema: { id: z.string() },
    },
    async (input: { id: string }) => {
      const tx = svc.transactionGet(input.id);
      return tx ? textResult(JSON.stringify(tx, null, 2)) : simErrorResult(new Error("not found"));
    },
  );

  registerTool(
    "proxy_repeater_send",
    {
      title: "Workbench: send request (Repeater)",
      description:
        "Send an arbitrary HTTP request and return the response (status, headers, body). Like Burp Repeater.",
      inputSchema: {
        secure: z.boolean(),
        host: z.string(),
        port: z.number(),
        method: z.string(),
        path: z.string(),
        headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
        body: z.string().optional(),
      },
    },
    async (input: {
      secure: boolean;
      host: string;
      port: number;
      method: string;
      path: string;
      headers?: { name: string; value: string }[];
      body?: string;
    }) => {
      try {
        const tx = await svc.repeaterSend({
          secure: input.secure,
          host: input.host,
          port: input.port,
          method: input.method,
          path: input.path,
          headers: input.headers ?? [],
          body: Buffer.from(input.body ?? "", "utf8"),
        });
        return textResult(JSON.stringify(tx, null, 2));
      } catch (err) {
        return simErrorResult(err);
      }
    },
  );

  registerTool(
    "proxy_intruder_run",
    {
      title: "Workbench: run Intruder",
      description:
        "Run a Sniper Intruder attack: substitute each payload into the §…§ marker in the request template and report status/length/time per payload (throttled + capped, like Community Edition).",
      inputSchema: {
        secure: z.boolean(),
        host: z.string(),
        port: z.number(),
        template: z.string(),
        payloads: z.array(z.string()),
      },
    },
    async (input: {
      secure: boolean;
      host: string;
      port: number;
      template: string;
      payloads: string[];
    }) => {
      try {
        const out = await svc.intruderRun(input);
        return textResult(JSON.stringify(out, null, 2));
      } catch (err) {
        return simErrorResult(err);
      }
    },
  );

  registerTool(
    "proxy_ca_export",
    {
      title: "Workbench: export CA certificate",
      description:
        "Return the Workbench root CA certificate (PEM) to trust in a simulator (xcrun simctl keychain booted add-root-cert). Auto-approved (read-only).",
      inputSchema: {},
    },
    async () => textResult(svc.caExportPem()),
  );

  // Batch installs, Frida unpinning and simulator CA trust act on iOS simulators (macOS
  // hosts only).
  if (support.iosSimulators) {
    registerTool(
      "sim_install_batch",
      {
        title: "Simulator: install app on many",
        description:
          "Install a .app or .ipa onto one or more simulators at once. NOTE: a simulator only runs SIMULATOR builds — App Store / device .ipa files (ARM + FairPlay) are rejected. Returns per-simulator ok/error.",
        inputSchema: {
          udids: z.array(z.string()).min(1),
          filePath: z.string(),
        },
      },
      async (input: { udids: string[]; filePath: string }) => {
        try {
          // Devices provides the simulator installer; Workbench requires Devices.
          const installer = params.simulatorInstaller;
          if (!installer) return textResult("Devices is not available.");
          const results = await installer.installOnMany(input.udids, input.filePath);
          return textResult(JSON.stringify(results, null, 2));
        } catch (err) {
          return simErrorResult(err);
        }
      },
    );

    registerTool(
      "proxy_frida_available",
      {
        title: "Workbench: Frida availability",
        description:
          "Report whether the host `frida` CLI is installed (needed for TLS-pinning bypass). Auto-approved (read-only).",
        inputSchema: {},
      },
      async () => textResult(JSON.stringify(await fridaAvailability(), null, 2)),
    );

    registerTool(
      "proxy_frida_install",
      {
        title: "Workbench: install Frida",
        description:
          "Install Frida (frida-tools) on this host via pipx/pip so TLS unpinning works. Use when proxy_frida_available reports frida=false.",
        inputSchema: {},
      },
      async () => textResult(JSON.stringify(await installFrida(), null, 2)),
    );

    registerTool(
      "proxy_frida_unpin",
      {
        title: "Workbench: Frida TLS unpin",
        description:
          "Launch an app on a simulator and attach the generic (app-agnostic) TLS-pinning bypass via Frida. Works for whatever app runs on the simulator. Returns the injected PID.",
        inputSchema: { udid: z.string(), bundleId: z.string() },
      },
      async (input: { udid: string; bundleId: string }) => {
        try {
          const handle = await launchAndUnpin({ udid: input.udid, bundleId: input.bundleId });
          return textResult(`unpinned ${input.bundleId} on ${input.udid} (pid ${handle.pid})`);
        } catch (err) {
          return simErrorResult(err);
        }
      },
    );

    registerTool(
      "proxy_ca_install_sim",
      {
        title: "Workbench: trust CA on simulator",
        description:
          "Install the Workbench CA into a booted simulator's trust store so its HTTPS is inspectable (xcrun simctl keychain add-root-cert).",
        inputSchema: { udid: z.string() },
      },
      async (input: { udid: string }) => {
        try {
          await installCaToSimulator(input.udid, svc.caCertFilePath());
          return textResult(`CA installed on ${input.udid}`);
        } catch (err) {
          return simErrorResult(err);
        }
      },
    );
  }
}
