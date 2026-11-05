import type { SnapshotPage } from "./snapshot-engine.js";

export interface ActionablePoint {
  x: number;
  y: number;
}

export interface ActionableTarget {
  point: ActionablePoint;
  rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export type ActionabilityResult =
  | { ok: true; target: ActionableTarget }
  | { ok: false; reason: "stale_ref" | "timeout"; detail?: string };

const DEFAULT_ACTIONABILITY_TIMEOUT_MS = 5_000;

export async function waitForActionableTarget(input: {
  page: SnapshotPage;
  elementExpression: string;
  editable?: boolean;
  timeoutMs?: number;
}): Promise<ActionabilityResult> {
  const result = await input.page.executeJavaScript(
    buildActionabilityScript({
      elementExpression: input.elementExpression,
      editable: input.editable === true,
      timeoutMs: input.timeoutMs ?? DEFAULT_ACTIONABILITY_TIMEOUT_MS,
    }),
  );
  return readActionabilityResult(result);
}

function readActionabilityResult(value: unknown): ActionabilityResult {
  if (!value || typeof value !== "object") {
    return { ok: false, reason: "timeout" };
  }
  const record = value as Record<string, unknown>;
  if (record.ok === true && isActionableTarget(record.target)) {
    return { ok: true, target: record.target };
  }
  if (record.ok === false) {
    const reason = record.reason;
    if (reason === "stale_ref" || reason === "timeout") {
      return {
        ok: false,
        reason,
        ...(typeof record.detail === "string" ? { detail: record.detail } : {}),
      };
    }
  }
  return { ok: false, reason: "timeout" };
}

function isActionableTarget(value: unknown): value is ActionableTarget {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return isPoint(record.point) && isRect(record.rect);
}

function isPoint(value: unknown): value is ActionablePoint {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return isFiniteNumber(record.x) && isFiniteNumber(record.y);
}

function isRect(value: unknown): value is ActionableTarget["rect"] {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    isFiniteNumber(record.x) &&
    isFiniteNumber(record.y) &&
    isFiniteNumber(record.width) &&
    isFiniteNumber(record.height)
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function buildActionabilityScript(input: {
  elementExpression: string;
  editable: boolean;
  timeoutMs: number;
}): string {
  return String.raw`(async () => {
    const deadline = performance.now() + ${JSON.stringify(input.timeoutMs)};
    const requiresEditable = ${JSON.stringify(input.editable)};

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    // Electron can suspend requestAnimationFrame while a guest is parked after
    // workspace LRU eviction even though the guest remains CDP-controllable.
    // Timed layout samples keep background browser automation live.
    const waitForLayout = () => sleep(16);
    const nearlyEqual = (a, b) => Math.abs(a - b) < 0.25;
    const sameRect = (a, b) =>
      nearlyEqual(a.x, b.x) &&
      nearlyEqual(a.y, b.y) &&
      nearlyEqual(a.width, b.width) &&
      nearlyEqual(a.height, b.height);
    const rectPayload = (rect) => ({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
    const centerPoint = (rect) => ({
      x: Math.min(Math.max(rect.left + rect.width / 2, 0), Math.max(window.innerWidth - 1, 0)),
      y: Math.min(Math.max(rect.top + rect.height / 2, 0), Math.max(window.innerHeight - 1, 0)),
    });
    const isDisabled = (element) => {
      if (element.closest?.('[aria-disabled="true"]')) return true;
      if ('disabled' in element && element.disabled) return true;
      const fieldset = element.closest?.('fieldset[disabled]');
      return Boolean(fieldset);
    };
    const isEditable = (element) => {
      if (element.isContentEditable) return true;
      const tag = element.tagName?.toLowerCase();
      if (tag === 'textarea' || tag === 'select') return !element.readOnly && !isDisabled(element);
      if (tag !== 'input') return false;
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(type)) return false;
      return !element.readOnly && !isDisabled(element);
    };
    const ownerView = (element) => (element.ownerDocument && element.ownerDocument.defaultView) || window;
    const isVisible = (element, rect) => {
      const style = ownerView(element).getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number(style.opacity || '1') !== 0
      );
    };
    const frameInset = (frame) => {
      const style = ownerView(frame).getComputedStyle(frame);
      return {
        left: (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.paddingLeft) || 0),
        top: (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.paddingTop) || 0),
      };
    };
    // An element inside a same-origin iframe reports frame-local coordinates; project
    // them into the top frame so CDP dispatches the click at the right screen point.
    const absoluteRect = (element) => {
      const rect = element.getBoundingClientRect();
      let left = rect.left;
      let top = rect.top;
      let view = ownerView(element);
      let guard = 0;
      while (view && view.frameElement && guard < 20) {
        guard += 1;
        const frameRect = view.frameElement.getBoundingClientRect();
        const inset = frameInset(view.frameElement);
        left += frameRect.left + inset.left;
        top += frameRect.top + inset.top;
        view = view.parent !== view ? view.parent : null;
      }
      return { left, top, width: rect.width, height: rect.height };
    };
    // elementFromPoint stops at a shadow host or iframe boundary, so descend through
    // open shadow roots and same-origin frames to the element that receives the event.
    const deepElementFromPoint = (startX, startY) => {
      let x = startX;
      let y = startY;
      let node = document.elementFromPoint(x, y);
      let guard = 0;
      while (node && guard < 20) {
        guard += 1;
        if (node.shadowRoot) {
          const inner = node.shadowRoot.elementFromPoint(x, y);
          if (!inner || inner === node) break;
          node = inner;
          continue;
        }
        if (node.tagName === 'IFRAME' || node.tagName === 'FRAME') {
          let doc = null;
          try {
            doc = node.contentDocument;
          } catch (error) {
            doc = null;
          }
          if (!doc) break;
          const frameRect = node.getBoundingClientRect();
          const inset = frameInset(node);
          x = x - frameRect.left - inset.left;
          y = y - frameRect.top - inset.top;
          const inner = doc.elementFromPoint(x, y);
          if (!inner) break;
          node = inner;
          continue;
        }
        break;
      }
      return node;
    };
    // The click reaches the target if walking up from the hit (through parents, shadow
    // hosts, and frame owners) arrives at the target.
    const hitTargetReceivesEvents = (element, point) => {
      let node = deepElementFromPoint(point.x, point.y);
      let guard = 0;
      while (node && guard < 40) {
        guard += 1;
        if (node === element) return true;
        const root = node.getRootNode ? node.getRootNode() : null;
        const view = node.ownerDocument && node.ownerDocument.defaultView;
        node = node.parentNode || (root && root.host) || (view && view.frameElement) || null;
      }
      return false;
    };
    const resolveElement = () => (${input.elementExpression});

    let detail = 'not actionable';
    while (performance.now() <= deadline) {
      const element = resolveElement();
      if (!element || !element.isConnected) {
        return { ok: false, reason: 'stale_ref', detail: 'ref no longer resolves' };
      }

      const rect = element.getBoundingClientRect();
      if (!isVisible(element, rect)) {
        detail = 'not visible';
        await sleep(25);
        continue;
      }
      if (isDisabled(element)) {
        detail = 'disabled';
        await sleep(25);
        continue;
      }
      if (requiresEditable && !isEditable(element)) {
        detail = 'not editable';
        await sleep(25);
        continue;
      }

      element.scrollIntoView?.({ block: 'center', inline: 'center' });
      await waitForLayout();
      const firstRect = element.getBoundingClientRect();
      await waitForLayout();
      const secondRect = element.getBoundingClientRect();
      if (!sameRect(firstRect, secondRect)) {
        detail = 'moving';
        continue;
      }

      // Click coordinates must be top-frame absolute; the stability check above stays
      // frame-local (it only compares movement between samples).
      const point = centerPoint(absoluteRect(element));
      if (!hitTargetReceivesEvents(element, point)) {
        detail = 'covered';
        await sleep(25);
        continue;
      }

      return { ok: true, target: { point, rect: rectPayload(secondRect) } };
    }

    return { ok: false, reason: 'timeout', detail };
  })()`;
}
