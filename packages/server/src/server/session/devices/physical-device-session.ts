import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "@jagentdesk/protocol/messages";
import { encodeScreenFrame } from "@jagentdesk/protocol/binary-frames/index";
import { DeviceError } from "../../devices/errors.js";
import {
  isPhysicalUdid,
  type PhysicalDeviceHub,
  type ScreenFrameEvent,
} from "../../devices/hub.js";
import { SCREEN_MAX_DIM } from "../../devices/image.js";

// The per-client half of physical devices (spec 27.7): the new simulator/physical/* and
// simulator/screen/* RPCs, plus every simulator/* RPC whose udid names a physical device. One
// PhysicalDeviceHub serves all sessions; this owns only the client's screen subscriptions.

export interface PhysicalDeviceSessionHost {
  emit(msg: SessionOutboundMessage): void;
  emitBinary(frame: Uint8Array): void;
  supportsBinaryScreenFrames(): boolean;
  transportBufferedAmount(): number | null;
}

const SCREEN_MAX_FPS = 15;
// A drawn frame is ≤ ~150 KB; more than this unsent means the client is behind, so the newest
// frame is dropped instead of queued (ADR-0033 decision 5).
const MAX_BUFFERED_BYTES = 384 * 1024;

interface ScreenSubscription {
  udid: string;
  seq: number;
  // Earliest time the next frame may go out; advances by intervalMs per frame sent.
  nextAllowedAt: number;
  intervalMs: number;
  unsubscribe: () => void;
}

// RPC `error`: coded refusals travel as the bare code; anything else as its message.
export function deviceErrorText(error: unknown): string {
  if (error instanceof DeviceError) return error.code;
  return error instanceof Error ? error.message : String(error);
}

function unsupported(what: string): DeviceError {
  return new DeviceError("unsupported_on_platform", `${what} is not available on physical devices`);
}

type Inbound<T extends SessionInboundMessage["type"]> = Extract<SessionInboundMessage, { type: T }>;

export class PhysicalDeviceSession {
  private readonly screens = new Map<string, ScreenSubscription>();

  constructor(
    private readonly hub: PhysicalDeviceHub,
    private readonly host: PhysicalDeviceSessionHost,
    private readonly logger: pino.Logger,
  ) {}

  // Returns undefined when the message is not for a physical device.
  // oxlint-disable-next-line complexity
  handle(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "simulator/physical/enable":
      case "simulator/physical/disable":
        return this.toggle(msg);
      case "simulator/physical/prepare":
        return this.prepare(msg);
      case "simulator/physical/pair_wireless":
        return this.pairWireless(msg);
      case "simulator/screen/subscribe":
        return this.subscribeScreen(msg);
      case "simulator/screen/unsubscribe":
        this.unsubscribeScreen(msg.subscriptionId);
        this.host.emit({
          type: "simulator/screen/unsubscribe/response",
          payload: { requestId: msg.requestId, error: null, subscriptionId: msg.subscriptionId },
        });
        return Promise.resolve();
      default:
        return this.handleDeviceRpc(msg);
    }
  }

  // oxlint-disable-next-line complexity
  private handleDeviceRpc(msg: SessionInboundMessage): Promise<void> | undefined {
    if (!("udid" in msg) || typeof msg.udid !== "string" || !isPhysicalUdid(msg.udid)) {
      return undefined;
    }
    const { requestId } = msg;
    switch (msg.type) {
      case "simulator/tap":
        return this.run(
          () => this.hub.tap(msg.udid, msg.x, msg.y, msg.coords),
          (error) => ({ type: "simulator/tap/response", payload: { requestId, error } }),
        );
      case "simulator/swipe":
        return this.run(
          () =>
            this.hub.swipe(
              msg.udid,
              { x: msg.x1, y: msg.y1 },
              { x: msg.x2, y: msg.y2 },
              msg.durationMs,
              msg.coords,
            ),
          (error) => ({ type: "simulator/swipe/response", payload: { requestId, error } }),
        );
      case "simulator/input-text":
        return this.run(
          () => this.hub.inputText(msg.udid, msg.text),
          (error) => ({ type: "simulator/input-text/response", payload: { requestId, error } }),
        );
      case "simulator/button":
        return this.run(
          () => this.hub.button(msg.udid, msg.button),
          (error) => ({ type: "simulator/button/response", payload: { requestId, error } }),
        );
      case "simulator/describe-ui":
        return this.describeUi(msg);
      case "simulator/screenshot":
        return this.screenshot(msg);
      case "simulator/install-app":
        return this.run(
          () => this.hub.installApp(msg.udid, msg.appPath),
          (error) => ({ type: "simulator/install-app/response", payload: { requestId, error } }),
        );
      case "simulator/launch-app":
        return this.run(
          () => this.hub.launchApp(msg.udid, msg.bundleId, msg.terminateExisting),
          (error) => ({ type: "simulator/launch-app/response", payload: { requestId, error } }),
        );
      case "simulator/terminate-app":
        return this.run(
          () => this.hub.terminateApp(msg.udid, msg.bundleId),
          (error) => ({ type: "simulator/terminate-app/response", payload: { requestId, error } }),
        );
      case "simulator/open-url":
        return this.run(
          () => this.hub.openUrl(msg.udid, msg.url),
          (error) => ({ type: "simulator/open-url/response", payload: { requestId, error } }),
        );
      case "simulator/action":
        // Spec 27.5: physical devices have no create/boot/shutdown/erase/delete.
        this.host.emit({
          type: "simulator/action/response",
          payload: { requestId, error: deviceErrorText(unsupported(msg.action)), udid: msg.udid },
        });
        return Promise.resolve();
      case "simulator/slim":
      case "simulator/unslim":
        this.host.emit({
          type:
            msg.type === "simulator/slim" ? "simulator/slim/response" : "simulator/unslim/response",
          payload: {
            requestId,
            error: deviceErrorText(unsupported("Slim")),
            udid: msg.udid,
            slimState: "unknown",
          },
        });
        return Promise.resolve();
      default:
        return undefined;
    }
  }

  private async run(
    operation: () => Promise<void>,
    respond: (error: string | null) => SessionOutboundMessage,
  ): Promise<void> {
    try {
      await operation();
      this.host.emit(respond(null));
    } catch (error) {
      this.host.emit(respond(deviceErrorText(error)));
    }
  }

  private async describeUi(msg: Inbound<"simulator/describe-ui">): Promise<void> {
    try {
      const elements = await this.hub.describeUi(msg.udid);
      this.host.emit({
        type: "simulator/describe-ui/response",
        payload: { requestId: msg.requestId, error: null, elements },
      });
    } catch (error) {
      this.host.emit({
        type: "simulator/describe-ui/response",
        payload: { requestId: msg.requestId, error: deviceErrorText(error), elements: [] },
      });
    }
  }

  private async screenshot(msg: Inbound<"simulator/screenshot">): Promise<void> {
    try {
      const shot = await this.hub.screenshot(msg.udid, { format: msg.format, maxDim: msg.maxDim });
      this.host.emit({
        type: "simulator/screenshot/response",
        payload: {
          requestId: msg.requestId,
          error: null,
          pngBase64: shot.mimeType === "image/png" ? shot.base64 : "",
          imageBase64: shot.base64,
          mimeType: shot.mimeType,
          width: shot.width,
          height: shot.height,
        },
      });
    } catch (error) {
      this.host.emit({
        type: "simulator/screenshot/response",
        payload: { requestId: msg.requestId, error: deviceErrorText(error), pngBase64: "" },
      });
    }
  }

  private async toggle(
    msg: Inbound<"simulator/physical/enable"> | Inbound<"simulator/physical/disable">,
  ): Promise<void> {
    const enable = msg.type === "simulator/physical/enable";
    const type = enable
      ? "simulator/physical/enable/response"
      : "simulator/physical/disable/response";
    try {
      if (enable) await this.hub.enable(msg.udid);
      else await this.hub.disable(msg.udid);
      this.host.emit({
        type,
        payload: { requestId: msg.requestId, error: null, udid: msg.udid, controlEnabled: enable },
      });
    } catch (error) {
      this.host.emit({
        type,
        payload: {
          requestId: msg.requestId,
          error: deviceErrorText(error),
          udid: msg.udid,
          controlEnabled: this.hub.isControlEnabled(msg.udid),
        },
      });
    }
  }

  private async prepare(msg: Inbound<"simulator/physical/prepare">): Promise<void> {
    const { requestId, udid } = msg;
    try {
      const result = await this.hub.prepare(udid, msg.accountId, (step, message) => {
        this.host.emit({
          type: "simulator/physical/prepare/progress",
          payload: { requestId, udid, step, message },
        });
      });
      this.host.emit({
        type: "simulator/physical/prepare/response",
        payload: { requestId, error: null, udid, accounts: [], ...result },
      });
    } catch (error) {
      const accounts =
        error instanceof DeviceError && error.code === "account_required"
          ? await this.hub.signerAccounts()
          : [];
      this.host.emit({
        type: "simulator/physical/prepare/response",
        payload: {
          requestId,
          error: deviceErrorText(error),
          udid,
          accounts,
          bundleId: null,
          expiresAt_ms: null,
        },
      });
    }
  }

  private async pairWireless(msg: Inbound<"simulator/physical/pair_wireless">): Promise<void> {
    try {
      const udid = await this.hub.pairWireless(msg);
      this.host.emit({
        type: "simulator/physical/pair_wireless/response",
        payload: { requestId: msg.requestId, error: null, udid },
      });
    } catch (error) {
      this.host.emit({
        type: "simulator/physical/pair_wireless/response",
        payload: { requestId: msg.requestId, error: deviceErrorText(error), udid: "" },
      });
    }
  }

  private async subscribeScreen(msg: Inbound<"simulator/screen/subscribe">): Promise<void> {
    const { requestId, subscriptionId, udid } = msg;
    const respond = (error: string | null, source: "scrcpy" | "screencap" | "wda-mjpeg" | null) =>
      this.host.emit({
        type: "simulator/screen/subscribe/response",
        payload: { requestId, error, subscriptionId, source },
      });
    if (!this.host.supportsBinaryScreenFrames()) {
      respond("binary_screen_frames_unsupported", null);
      return;
    }
    this.unsubscribeScreen(subscriptionId);
    const maxFps = Math.min(msg.maxFps ?? SCREEN_MAX_FPS, SCREEN_MAX_FPS);
    const subscription: ScreenSubscription = {
      udid,
      seq: 0,
      nextAllowedAt: 0,
      intervalMs: 1000 / maxFps,
      unsubscribe: () => {},
    };
    this.screens.set(subscriptionId, subscription);
    try {
      const { source, unsubscribe } = await this.hub.subscribeScreen(udid, {
        onFrame: (frame) => this.sendFrame(subscriptionId, subscription, frame),
        onEnd: (reason) => {
          this.logger.debug({ subscriptionId, reason }, "screen subscription ended");
          if (this.screens.get(subscriptionId) === subscription)
            this.screens.delete(subscriptionId);
        },
      });
      subscription.unsubscribe = unsubscribe;
      if (this.screens.get(subscriptionId) !== subscription) {
        unsubscribe();
        return;
      }
      respond(null, source);
    } catch (error) {
      if (this.screens.get(subscriptionId) === subscription) this.screens.delete(subscriptionId);
      respond(deviceErrorText(error), null);
    }
  }

  private sendFrame(
    subscriptionId: string,
    subscription: ScreenSubscription,
    frame: ScreenFrameEvent,
  ): void {
    // Credit-based cap: the average stays ≤ maxFps, but decode jitter (two frames 50 ms apart from
    // a 15 fps source) does not cost a frame; a credit older than one interval is not kept.
    const now = frame.timestamp_ms;
    if (now < subscription.nextAllowedAt) return;
    const buffered = this.host.transportBufferedAmount();
    if (buffered !== null && buffered > MAX_BUFFERED_BYTES) return;
    if (Math.max(frame.width, frame.height) > SCREEN_MAX_DIM) return;
    subscription.seq += 1;
    subscription.nextAllowedAt =
      Math.max(subscription.nextAllowedAt, now - subscription.intervalMs) + subscription.intervalMs;
    this.host.emitBinary(
      encodeScreenFrame({
        subscriptionId,
        seq: subscription.seq,
        width: frame.width,
        height: frame.height,
        timestamp_ms: frame.timestamp_ms,
        jpeg: frame.jpeg,
      }),
    );
  }

  private unsubscribeScreen(subscriptionId: string): void {
    const subscription = this.screens.get(subscriptionId);
    if (!subscription) return;
    this.screens.delete(subscriptionId);
    subscription.unsubscribe();
  }

  dispose(): void {
    for (const id of Array.from(this.screens.keys())) this.unsubscribeScreen(id);
  }
}
