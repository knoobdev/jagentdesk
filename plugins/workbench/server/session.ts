import type {
  BuiltinSessionContribution,
  BuiltinSessionServices,
  SessionInboundMessage,
} from "../../../packages/server/src/server/plugins/builtin/host-api.js";
import { fridaAvailability, installFrida } from "./proxy/frida-control.js";
import { getSharedProxyService } from "./proxy/proxy-service.js";

/**
 * The proxy/* surface of one client (Workbench): capture sessions, history, repeater, intruder,
 * intercept and Frida. The capture store is daemon-wide; this session owns its subscriptions.
 */
export class WorkbenchSession implements BuiltinSessionContribution {
  private readonly proxyService = getSharedProxyService();
  private readonly proxySubscriptionIds = new Set<string>();
  constructor(private readonly host: BuiltinSessionServices) {}

  handle(message: SessionInboundMessage): Promise<void> | undefined {
    return this.dispatchProxyMessage(message);
  }

  /** Plugin turned off or client gone: end this client's capture subscriptions. */
  stop(): void {
    for (const id of this.proxySubscriptionIds) this.proxyService.unsubscribe(id);
    this.proxySubscriptionIds.clear();
  }

  private dispatchProxyMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    const fail = (error: unknown): string =>
      error instanceof Error ? error.message : String(error);
    if (msg.type === "proxy/capture/start") {
      const { requestId } = msg;
      return this.proxyService
        .captureStart({ mode: msg.mode, label: msg.label, udid: msg.udid, bundleId: msg.bundleId })
        .then((session) => {
          this.host.push({
            type: "proxy/capture/start/response",
            payload: { requestId, error: null, session },
          });
          return undefined;
        })
        .catch((error) => {
          this.host.push({
            type: "proxy/capture/start/response",
            payload: { requestId, error: fail(error), session: null },
          });
          return undefined;
        });
    }
    if (msg.type === "proxy/capture/stop") {
      const { requestId, sessionId } = msg;
      return this.proxyService
        .captureStop(sessionId)
        .then(() => {
          this.host.push({
            type: "proxy/capture/stop/response",
            payload: { requestId, error: null, sessionId },
          });
          return undefined;
        })
        .catch((error) => {
          this.host.push({
            type: "proxy/capture/stop/response",
            payload: { requestId, error: fail(error), sessionId },
          });
          return undefined;
        });
    }
    if (msg.type === "proxy/session/remove") {
      const { requestId, sessionId } = msg;
      return this.proxyService
        .removeSession(sessionId)
        .then(() => {
          this.host.push({
            type: "proxy/session/remove/response",
            payload: { requestId, error: null, sessionId },
          });
          return undefined;
        })
        .catch((error) => {
          this.host.push({
            type: "proxy/session/remove/response",
            payload: { requestId, error: fail(error), sessionId },
          });
          return undefined;
        });
    }
    if (msg.type === "proxy/sessions/list") {
      const { requestId } = msg;
      this.host.push({
        type: "proxy/sessions/list/response",
        payload: { requestId, error: null, sessions: this.proxyService.sessionsList() },
      });
      return undefined;
    }
    if (msg.type === "proxy/history/query") {
      const { requestId } = msg;
      const rows = this.proxyService.historyQuery({
        sessionId: msg.sessionId,
        host: msg.host,
        method: msg.method,
        status: msg.status,
        contains: msg.contains,
        limit: msg.limit,
      });
      this.host.push({
        type: "proxy/history/query/response",
        payload: { requestId, error: null, rows },
      });
      return undefined;
    }
    if (msg.type === "proxy/transaction/get") {
      const { requestId } = msg;
      this.host.push({
        type: "proxy/transaction/get/response",
        payload: { requestId, error: null, transaction: this.proxyService.transactionGet(msg.id) },
      });
      return undefined;
    }
    if (msg.type === "proxy/history/clear") {
      const { requestId } = msg;
      this.proxyService.clearHistory(msg.sessionId);
      this.host.push({ type: "proxy/history/clear/response", payload: { requestId, error: null } });
      return undefined;
    }
    if (msg.type === "proxy/transaction/delete") {
      const { requestId, id } = msg;
      this.proxyService.deleteTransaction(id);
      this.host.push({
        type: "proxy/transaction/delete/response",
        payload: { requestId, error: null, id },
      });
      return undefined;
    }
    if (msg.type === "proxy/transaction/annotate") {
      const { requestId } = msg;
      const row = this.proxyService.annotate(msg.id, {
        comment: msg.comment,
        highlight: msg.highlight,
      });
      this.host.push({
        type: "proxy/transaction/annotate/response",
        payload: { requestId, error: null, row },
      });
      return undefined;
    }
    if (msg.type === "proxy/ca/export") {
      const { requestId } = msg;
      try {
        this.host.push({
          type: "proxy/ca/export/response",
          payload: { requestId, error: null, pem: this.proxyService.caExportPem() },
        });
      } catch (error) {
        this.host.push({
          type: "proxy/ca/export/response",
          payload: { requestId, error: fail(error), pem: "" },
        });
      }
      return undefined;
    }
    return this.dispatchProxyMessageContinued(msg);
  }

  private dispatchProxyMessageContinued(msg: SessionInboundMessage): Promise<void> | undefined {
    const fail = (error: unknown): string =>
      error instanceof Error ? error.message : String(error);
    if (msg.type === "proxy/repeater/send") {
      const { requestId } = msg;
      return this.proxyService
        .repeaterSend({
          secure: msg.secure,
          host: msg.host,
          port: msg.port,
          method: msg.method,
          path: msg.path,
          headers: msg.headers,
          body: Buffer.from(msg.bodyB64, "base64"),
        })
        .then((transaction) => {
          this.host.push({
            type: "proxy/repeater/send/response",
            payload: { requestId, error: null, transaction },
          });
          return undefined;
        })
        .catch((error) => {
          this.host.push({
            type: "proxy/repeater/send/response",
            payload: { requestId, error: fail(error), transaction: null },
          });
          return undefined;
        });
    }
    if (msg.type === "proxy/intercept/set") {
      const { requestId } = msg;
      const enabled = this.proxyService.setIntercept(msg.enabled);
      this.host.push({
        type: "proxy/intercept/set/response",
        payload: { requestId, error: null, enabled },
      });
      return undefined;
    }
    if (msg.type === "proxy/intercept/decide") {
      const { requestId, heldId } = msg;
      this.proxyService.decideIntercept({
        heldId,
        action: msg.action,
        method: msg.method,
        path: msg.path,
        headers: msg.headers,
        bodyB64: msg.bodyB64,
      });
      this.host.push({
        type: "proxy/intercept/decide/response",
        payload: { requestId, error: null, heldId },
      });
      return undefined;
    }
    if (msg.type === "proxy/intruder/run") {
      const { requestId } = msg;
      return this.proxyService
        .intruderRun({
          secure: msg.secure,
          host: msg.host,
          port: msg.port,
          template: msg.template,
          payloads: msg.payloads,
        })
        .then((out) => {
          this.host.push({
            type: "proxy/intruder/run/response",
            payload: { requestId, error: null, ...out },
          });
          return undefined;
        })
        .catch((error) => {
          this.host.push({
            type: "proxy/intruder/run/response",
            payload: {
              requestId,
              error: fail(error),
              results: [],
              throttled: false,
              truncated: false,
            },
          });
          return undefined;
        });
    }
    if (msg.type === "proxy/frida/status") {
      const { requestId } = msg;
      return fridaAvailability()
        .then((a) => {
          this.host.push({
            type: "proxy/frida/status/response",
            payload: {
              requestId,
              error: null,
              frida: a.frida,
              version: a.version,
              installer: a.installer,
            },
          });
          return undefined;
        })
        .catch((error) => {
          this.host.push({
            type: "proxy/frida/status/response",
            payload: {
              requestId,
              error: fail(error),
              frida: false,
              version: null,
              installer: null,
            },
          });
          return undefined;
        });
    }
    if (msg.type === "proxy/frida/install") {
      const { requestId } = msg;
      return installFrida()
        .then((r) => {
          this.host.push({
            type: "proxy/frida/install/response",
            payload: { requestId, error: null, ok: r.ok, log: r.log, frida: r.availability.frida },
          });
          return undefined;
        })
        .catch((error) => {
          this.host.push({
            type: "proxy/frida/install/response",
            payload: { requestId, error: fail(error), ok: false, log: "", frida: false },
          });
          return undefined;
        });
    }
    if (msg.type === "proxy/scope/get") {
      const { requestId } = msg;
      this.host.push({
        type: "proxy/scope/get/response",
        payload: { requestId, error: null, rules: this.proxyService.getScope() },
      });
      return undefined;
    }
    if (msg.type === "proxy/scope/set") {
      const { requestId } = msg;
      this.host.push({
        type: "proxy/scope/set/response",
        payload: { requestId, error: null, rules: this.proxyService.setScope(msg.rules) },
      });
      return undefined;
    }
    if (msg.type === "proxy/subscribe") {
      const { requestId, subscriptionId } = msg;
      this.proxySubscriptionIds.add(subscriptionId);
      this.proxyService.subscribe(subscriptionId, {
        onTransaction: (row) =>
          this.host.push({ type: "proxy/transaction", payload: { subscriptionId, row } }),
        onSession: (session) =>
          this.host.push({ type: "proxy/session", payload: { subscriptionId, session } }),
        onHeld: (held) =>
          this.host.push({ type: "proxy/intercept/held", payload: { subscriptionId, held } }),
        onWsMessage: (message) =>
          this.host.push({ type: "proxy/ws-message", payload: { subscriptionId, message } }),
      });
      this.host.push({
        type: "proxy/subscribe/response",
        payload: { requestId, error: null, subscriptionId },
      });
      return undefined;
    }
    if (msg.type === "proxy/unsubscribe") {
      const { requestId, subscriptionId } = msg;
      this.proxySubscriptionIds.delete(subscriptionId);
      this.proxyService.unsubscribe(subscriptionId);
      this.host.push({
        type: "proxy/unsubscribe/response",
        payload: { requestId, error: null, subscriptionId },
      });
      return undefined;
    }
    return undefined;
  }
}
