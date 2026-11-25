import { CLIENT_CAPS } from "@jagentdesk/protocol/client-capabilities";
import type {
  BuiltinSessionContribution,
  BuiltinSessionServices,
  SessionInboundMessage,
} from "../../../packages/server/src/server/plugins/builtin/host-api.js";
import type { PhysicalDeviceHub } from "./devices/hub.js";
import { PhysicalDeviceSession, deviceErrorText } from "./physical-device-session.js";
import { SimulatorService } from "./simulator/simulator-service.js";
import { SimulatorStreams, fleetSnapshot } from "./simulator/simulator-streams.js";

/**
 * The simulator/* surface of one client (spec 24 / 27): the fleet, simulator control, physical
 * devices and their screen streams. Physical devices answer first; a simulator udid falls through
 * to SimulatorService.
 */
export class DevicesSession implements BuiltinSessionContribution {
  private readonly simulatorService = new SimulatorService();
  private readonly simulatorStreams: SimulatorStreams;
  private readonly physicalDeviceSession: PhysicalDeviceSession | null;
  constructor(
    private readonly host: BuiltinSessionServices,
    private readonly physicalDevices: PhysicalDeviceHub | null,
  ) {
    this.simulatorStreams = new SimulatorStreams(this.simulatorService, this.physicalDevices);
    this.physicalDeviceSession = this.createPhysicalDeviceSession();
  }

  handle(message: SessionInboundMessage): Promise<void> | undefined {
    return this.dispatchSimulatorMessage(message);
  }

  /** Plugin turned off or client gone: end fleet/log subscriptions and screen streams. */
  stop(): void {
    this.simulatorStreams.disposeAll();
    this.physicalDeviceSession?.dispose();
  }

  // The fleet itself: listing it, what the host can run, and adding devices to it.
  private dispatchSimulatorFleet(
    msg: SessionInboundMessage,
    fail: (error: unknown) => string,
  ): Promise<void> | undefined {
    if (msg.type === "simulator/list") {
      const { requestId } = msg;
      return fleetSnapshot(this.simulatorService, this.physicalDevices)
        .then((result) => {
          this.host.push({
            type: "simulator/list/response",
            payload: { requestId, error: null, ...result },
          });
          return undefined;
        })
        .catch((error) => {
          this.host.push({
            type: "simulator/list/response",
            payload: {
              requestId,
              error: fail(error),
              availability: { simctl: false, idb: false, maestro: false, xcode: false },
              devices: [],
            },
          });
          return undefined;
        });
    }
    if (msg.type === "simulator/catalog") {
      const { requestId } = msg;
      return this.simulatorService
        .catalog()
        .then((runtimes) => {
          this.host.push({
            type: "simulator/catalog/response",
            payload: { requestId, error: null, runtimes },
          });
          return undefined;
        })
        .catch((error) => {
          this.host.push({
            type: "simulator/catalog/response",
            payload: { requestId, error: fail(error), runtimes: [] },
          });
          return undefined;
        });
    }
    if (msg.type === "simulator/create") {
      const { requestId } = msg;
      return this.simulatorService
        .create(msg.name, msg.deviceTypeId, msg.runtimeId, msg.boot ?? false)
        .then((udid) => {
          this.host.push({
            type: "simulator/create/response",
            payload: { requestId, error: null, udid },
          });
          return undefined;
        })
        .catch((error) => {
          this.host.push({
            type: "simulator/create/response",
            payload: { requestId, error: fail(error), udid: "" },
          });
          return undefined;
        });
    }
    return undefined;
  }

  private createPhysicalDeviceSession(): PhysicalDeviceSession | null {
    if (!this.physicalDevices) return null;
    return new PhysicalDeviceSession(
      this.physicalDevices,
      {
        emit: (msg) => this.host.push(msg),
        emitBinary: (frame) => this.host.pushBinary(frame),
        supportsBinaryScreenFrames: () =>
          this.host.supportsClientCapability(CLIENT_CAPS.binaryScreenFrames),
        transportBufferedAmount: () => this.host.transportBufferedAmount(),
      },
      this.host.logger,
    );
  }

  private dispatchSimulatorMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    const fail = (error: unknown): string =>
      error instanceof Error ? error.message : String(error);
    const physical = this.physicalDeviceSession?.handle(msg);
    if (physical) return physical;
    const fleet = this.dispatchSimulatorFleet(msg, fail);
    if (fleet) return fleet;
    if (msg.type === "simulator/action") {
      const { requestId, udid } = msg;
      return this.simulatorService
        .action(udid, msg.action)
        .then(() => {
          this.host.push({
            type: "simulator/action/response",
            payload: { requestId, error: null, udid },
          });
          return undefined;
        })
        .catch((error) => {
          this.host.push({
            type: "simulator/action/response",
            payload: { requestId, error: fail(error), udid },
          });
          return undefined;
        });
    }
    if (msg.type === "simulator/tap") {
      const { requestId } = msg;
      return this.simulatorService
        .tap(msg.udid, msg.x, msg.y)
        .then(() => {
          this.host.push({ type: "simulator/tap/response", payload: { requestId, error: null } });
          return undefined;
        })
        .catch((error) => {
          this.host.push({
            type: "simulator/tap/response",
            payload: { requestId, error: fail(error) },
          });
          return undefined;
        });
    }
    if (msg.type === "simulator/swipe") {
      const { requestId } = msg;
      return this.simulatorService
        .swipe(msg.udid, msg.x1, msg.y1, msg.x2, msg.y2, msg.durationMs)
        .then(() => {
          this.host.push({ type: "simulator/swipe/response", payload: { requestId, error: null } });
          return undefined;
        })
        .catch((error) => {
          this.host.push({
            type: "simulator/swipe/response",
            payload: { requestId, error: fail(error) },
          });
          return undefined;
        });
    }
    if (msg.type === "simulator/input-text") {
      const { requestId } = msg;
      return this.simulatorService
        .inputText(msg.udid, msg.text)
        .then(() => {
          this.host.push({
            type: "simulator/input-text/response",
            payload: { requestId, error: null },
          });
          return undefined;
        })
        .catch((error) => {
          this.host.push({
            type: "simulator/input-text/response",
            payload: { requestId, error: fail(error) },
          });
          return undefined;
        });
    }
    if (msg.type === "simulator/button") {
      const { requestId } = msg;
      return this.simulatorService
        .button(msg.udid, msg.button)
        .then(() => {
          this.host.push({
            type: "simulator/button/response",
            payload: { requestId, error: null },
          });
          return undefined;
        })
        .catch((error) => {
          this.host.push({
            type: "simulator/button/response",
            payload: { requestId, error: fail(error) },
          });
          return undefined;
        });
    }
    if (msg.type === "simulator/describe-ui") {
      const { requestId } = msg;
      return this.simulatorService
        .describeUi(msg.udid)
        .then((elements) => {
          this.host.push({
            type: "simulator/describe-ui/response",
            payload: { requestId, error: null, elements },
          });
          return undefined;
        })
        .catch((error) => {
          this.host.push({
            type: "simulator/describe-ui/response",
            payload: { requestId, error: fail(error), elements: [] },
          });
          return undefined;
        });
    }
    if (msg.type === "simulator/screenshot") {
      const { requestId } = msg;
      return this.simulatorService
        .screenshot(msg.udid, { format: msg.format, maxDim: msg.maxDim })
        .then((shot) => {
          this.host.push({
            type: "simulator/screenshot/response",
            payload: {
              requestId,
              error: null,
              pngBase64: shot.mimeType === "image/png" ? shot.base64 : "",
              imageBase64: shot.base64,
              mimeType: shot.mimeType,
              width: shot.width,
              height: shot.height,
            },
          });
          return undefined;
        })
        .catch((error) => {
          this.host.push({
            type: "simulator/screenshot/response",
            payload: { requestId, error: fail(error), pngBase64: "" },
          });
          return undefined;
        });
    }
    if (msg.type === "simulator/install-app") {
      const { requestId } = msg;
      return this.simulatorService
        .installApp(msg.udid, msg.appPath)
        .then(() => {
          this.host.push({
            type: "simulator/install-app/response",
            payload: { requestId, error: null },
          });
          return undefined;
        })
        .catch((error) => {
          this.host.push({
            type: "simulator/install-app/response",
            payload: { requestId, error: fail(error) },
          });
          return undefined;
        });
    }
    if (msg.type === "simulator/install-batch") {
      const { requestId } = msg;
      return this.simulatorService
        .installOnMany(msg.udids, msg.filePath)
        .then((results) => {
          this.host.push({
            type: "simulator/install-batch/response",
            payload: { requestId, error: null, results },
          });
          return undefined;
        })
        .catch((error) => {
          this.host.push({
            type: "simulator/install-batch/response",
            payload: { requestId, error: fail(error), results: [] },
          });
          return undefined;
        });
    }
    return this.dispatchSimulatorMessageContinued(msg);
  }

  private dispatchSimulatorMessageContinued(msg: SessionInboundMessage): Promise<void> | undefined {
    const fail = (error: unknown): string =>
      error instanceof Error ? error.message : String(error);
    if (msg.type === "simulator/launch-app") {
      const { requestId } = msg;
      return this.simulatorService
        .launchApp(msg.udid, msg.bundleId, msg.terminateExisting)
        .then(() => {
          this.host.push({
            type: "simulator/launch-app/response",
            payload: { requestId, error: null },
          });
          return undefined;
        })
        .catch((error) => {
          this.host.push({
            type: "simulator/launch-app/response",
            payload: { requestId, error: fail(error) },
          });
          return undefined;
        });
    }
    if (msg.type === "simulator/terminate-app") {
      const { requestId } = msg;
      return this.simulatorService
        .terminateApp(msg.udid, msg.bundleId)
        .then(() => {
          this.host.push({
            type: "simulator/terminate-app/response",
            payload: { requestId, error: null },
          });
          return undefined;
        })
        .catch((error) => {
          this.host.push({
            type: "simulator/terminate-app/response",
            payload: { requestId, error: fail(error) },
          });
          return undefined;
        });
    }
    if (msg.type === "simulator/open-url") {
      const { requestId } = msg;
      return this.simulatorService
        .openUrl(msg.udid, msg.url)
        .then(() => {
          this.host.push({
            type: "simulator/open-url/response",
            payload: { requestId, error: null },
          });
          return undefined;
        })
        .catch((error) => {
          this.host.push({
            type: "simulator/open-url/response",
            payload: { requestId, error: fail(error) },
          });
          return undefined;
        });
    }
    if (msg.type === "simulator/slim") {
      const { requestId, udid } = msg;
      return this.simulatorService
        .slim(udid, msg.reboot ?? false)
        .then((slimState) => {
          this.host.push({
            type: "simulator/slim/response",
            payload: { requestId, error: null, udid, slimState },
          });
          return undefined;
        })
        .catch((error) => {
          this.host.push({
            type: "simulator/slim/response",
            payload: { requestId, error: fail(error), udid, slimState: "unknown" },
          });
          return undefined;
        });
    }
    if (msg.type === "simulator/unslim") {
      const { requestId, udid } = msg;
      return this.simulatorService
        .unslim(udid)
        .then((slimState) => {
          this.host.push({
            type: "simulator/unslim/response",
            payload: { requestId, error: null, udid, slimState },
          });
          return undefined;
        })
        .catch((error) => {
          this.host.push({
            type: "simulator/unslim/response",
            payload: { requestId, error: fail(error), udid, slimState: "unknown" },
          });
          return undefined;
        });
    }
    if (msg.type === "simulator/subscribe") {
      const { requestId, subscriptionId } = msg;
      this.host.push({
        type: "simulator/subscribe/response",
        payload: { requestId, error: null, subscriptionId },
      });
      void this.simulatorStreams.subscribeFleet(subscriptionId, (snapshot) => {
        this.host.push({ type: "simulator/snapshot", payload: { subscriptionId, ...snapshot } });
      });
      return undefined;
    }
    if (msg.type === "simulator/unsubscribe") {
      const { requestId, subscriptionId } = msg;
      this.simulatorStreams.unsubscribeFleet(subscriptionId);
      this.host.push({
        type: "simulator/unsubscribe/response",
        payload: { requestId, error: null, subscriptionId },
      });
      return undefined;
    }
    if (msg.type === "simulator/logs/subscribe") {
      const { requestId, subscriptionId } = msg;
      return this.simulatorStreams
        .subscribeLogs(subscriptionId, msg.udid, (chunk) => {
          this.host.push({ type: "simulator/log-chunk", payload: { subscriptionId, chunk } });
        })
        .then(() => {
          this.host.push({
            type: "simulator/logs/subscribe/response",
            payload: { requestId, error: null, subscriptionId },
          });
          return undefined;
        })
        .catch((error: unknown) => {
          this.host.push({
            type: "simulator/logs/subscribe/response",
            payload: { requestId, error: deviceErrorText(error), subscriptionId },
          });
          return undefined;
        });
    }
    if (msg.type === "simulator/logs/unsubscribe") {
      const { requestId, subscriptionId } = msg;
      this.simulatorStreams.unsubscribeLogs(subscriptionId);
      this.host.push({
        type: "simulator/logs/unsubscribe/response",
        payload: { requestId, error: null, subscriptionId },
      });
      return undefined;
    }
    return undefined;
  }
}
