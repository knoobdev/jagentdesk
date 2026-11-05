// The JAgentDesk Figma Link plugin UI. It owns the WebSocket to the daemon
// (127.0.0.1:1995) — the sandbox has no sockets — and relays the bridge
// protocol: daemon `request` frames become `server-request` postMessages to
// the sandbox, and tool responses go back as `response` frames. Everything
// the daemon tells us (pairing code, blocked, rejected) is shown verbatim.
//
// Plain DOM on purpose: the repo has no React/vite toolchain in node_modules,
// and this window has three states to render.

import { BRIDGE_PROTOCOL_VERSION, PLUGIN_VERSION } from "../plugin-version";

const DAEMON_URL = "ws://127.0.0.1:1995/ws";
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 5_000;

interface PluginConfig {
  pluginVersion: string;
  instanceId: string;
  pairingId?: string;
  pairingKey?: string;
  fileName: string;
  fileKey: string;
  manager: string;
}

type UIState =
  | { kind: "waiting" }
  | { kind: "connecting" }
  | { kind: "unpaired"; code: string; expiresAt_ms: number }
  | { kind: "paired" }
  | { kind: "blocked"; reason: string; requiredVersion: string }
  | { kind: "rejected"; reason: string }
  | { kind: "offline" };

const root = document.getElementById("root") as HTMLElement;

let config: PluginConfig | null = null;
let state: UIState = { kind: "waiting" };
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = RECONNECT_MIN_MS;
let stopped = false;
/** Daemon request frames waiting for the sandbox to answer. */
const inFlight = new Map<string, string>(); // requestId → toolName

const setStatus = (text: string, tone: "" | "ok" | "warn" | "error") => {
  const status = document.getElementById("status") as HTMLElement;
  status.textContent = text;
  status.className = `status${tone ? ` status--${tone}` : ""}`;
};

const render = () => {
  const connected = document.getElementById("dot") as HTMLElement;
  const codeBox = document.getElementById("code") as HTMLElement;
  switch (state.kind) {
    case "waiting":
      connected.className = "dot dot--off";
      setStatus("Open JAgentDesk to connect.", "");
      codeBox.textContent = "";
      break;
    case "connecting":
      connected.className = "dot dot--off";
      setStatus("Connecting to JAgentDesk…", "");
      break;
    case "unpaired":
      connected.className = "dot dot--warn";
      setStatus("Enter this code in JAgentDesk to pair:", "warn");
      codeBox.textContent = state.code;
      break;
    case "paired":
      connected.className = "dot dot--on";
      setStatus(config ? `Connected · ${config.fileName}` : "Connected", "ok");
      codeBox.textContent = "";
      break;
    case "blocked":
      connected.className = "dot dot--warn";
      setStatus(`Update JAgentDesk — ${state.reason} (needs v${state.requiredVersion})`, "warn");
      codeBox.textContent = "";
      break;
    case "rejected":
      connected.className = "dot dot--off";
      setStatus(`Rejected by JAgentDesk: ${state.reason}`, "error");
      codeBox.textContent = "";
      break;
    case "offline":
      connected.className = "dot dot--off";
      setStatus("JAgentDesk is not running on this machine.", "");
      break;
  }
};

const send = (frame: Record<string, unknown>) => {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
};

const hello = () => {
  if (!config) return;
  send({
    type: "hello",
    name: "JAgentDesk Figma Link",
    version: PLUGIN_VERSION,
    protocol: BRIDGE_PROTOCOL_VERSION,
    fileKey: config.fileKey,
    fileName: config.fileName,
    manager: config.manager,
    instanceId: config.instanceId,
    ...(config.pairingId ? { pairingId: config.pairingId } : {}),
    ...(config.pairingKey ? { pairingKey: config.pairingKey } : {})
  });
};

const connect = () => {
  if (!config || stopped) return;
  state = { kind: "connecting" };
  render();
  const url = `${DAEMON_URL}?version=${encodeURIComponent(PLUGIN_VERSION)}&protocol=${BRIDGE_PROTOCOL_VERSION}&fileKey=${encodeURIComponent(config.fileKey)}&fileName=${encodeURIComponent(config.fileName)}`;
  const ws = new WebSocket(url);
  socket = ws;
  ws.onopen = () => {
    reconnectDelay = RECONNECT_MIN_MS;
    hello();
  };
  ws.onmessage = (event) => {
    let frame: { type?: string } & Record<string, unknown>;
    try {
      frame = JSON.parse(String(event.data));
    } catch {
      return;
    }
    switch (frame.type) {
      case "hello_ack":
        state = { kind: "paired" };
        render();
        return;
      case "pairing_required":
        state = {
          kind: "unpaired",
          code: String(frame.code ?? ""),
          expiresAt_ms: Number(frame.expiresAt_ms ?? 0)
        };
        render();
        return;
      case "pairing_granted": {
        state = { kind: "paired" };
        const pairingId = String(frame.pairingId ?? config?.pairingId ?? "");
        const pairingKey = String(frame.pairingKey ?? "");
        if (config) {
          config = { ...config, pairingId, pairingKey };
        }
        parent.postMessage({ pluginMessage: { type: "ui-store-pairing", pairingId, pairingKey } }, "*");
        render();
        return;
      }
      case "pairing_rejected":
        // The stored key did not match; pairing_required follows with a fresh code.
        return;
      case "link_blocked":
        state = {
          kind: "blocked",
          reason: String(frame.reason ?? "version mismatch"),
          requiredVersion: String(frame.requiredVersion ?? "?")
        };
        render();
        return;
      case "link_rejected":
        stopped = true;
        state = { kind: "rejected", reason: String(frame.reason ?? "rejected") };
        render();
        return;
      case "ping":
        send({ type: "pong", sentAt: frame.sentAt });
        return;
      case "request": {
        const requestId = String(frame.requestId ?? "");
        const toolName = String(frame.toolName ?? "");
        inFlight.set(requestId, toolName);
        parent.postMessage(
          {
            pluginMessage: {
              type: "server-request",
              payload: {
                type: toolName,
                requestId,
                nodeIds: frame.nodeIds,
                params: frame.params
              }
            }
          },
          "*"
        );
        return;
      }
      default:
        return;
    }
  };
  ws.onclose = () => {
    socket = null;
    if (stopped) return;
    for (const [requestId] of inFlight) {
      send({ type: "response", requestId, ok: false, message: "link closed" });
    }
    inFlight.clear();
    state = { kind: "offline" };
    render();
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  };
  ws.onerror = () => {
    // onclose follows and schedules the retry.
  };
};

// The sandbox answers tool requests by posting the response object back; the
// `type` field carries the tool name, `requestId` correlates the daemon frame.
const onSandboxMessage = (message: { type?: string; requestId?: string } & Record<string, unknown>) => {
  if (message.type === "plugin-config") {
    config = message.payload as unknown as PluginConfig;
    if (!socket && !stopped) connect();
    return;
  }
  if (message.type === "plugin-status") {
    const payload = message.payload as Record<string, unknown>;
    if (config) {
      config = { ...config, fileName: String(payload.fileName ?? config.fileName), fileKey: String(payload.fileKey ?? config.fileKey) };
    }
    if (socket && socket.readyState === WebSocket.OPEN) {
      send({ type: "plugin_status", ...payload });
    }
    return;
  }
  if (message.requestId && inFlight.has(String(message.requestId))) {
    const requestId = String(message.requestId);
    inFlight.delete(requestId);
    send({
      type: "response",
      requestId,
      ok: !message.error,
      message: typeof message.error === "string" ? message.error : "ok",
      data: message.data
    });
  }
};

window.onmessage = (event) => {
  const pluginMessage = (event.data as { pluginMessage?: Record<string, unknown> })?.pluginMessage;
  if (pluginMessage) onSandboxMessage(pluginMessage as { type?: string } & Record<string, unknown>);
};

const pairButton = document.getElementById("re-pair") as HTMLButtonElement;
pairButton.addEventListener("click", () => {
  stopped = false;
  reconnectDelay = RECONNECT_MIN_MS;
  parent.postMessage({ pluginMessage: { type: "ui-clear-pairing" } }, "*");
  config = config ? { ...config, pairingId: undefined, pairingKey: undefined } : config;
  if (socket) socket.close();
  else connect();
});

parent.postMessage({ pluginMessage: { type: "ui-ready" } }, "*");
render();
