import type { FigmaFrameSummary, FigmaRect } from "@jagentdesk/protocol/figma/rpc-schemas";

// Pan/zoom camera for the Figma canvas (spec 32.5.1). Screen pixels map to Figma units by
// `figma = (screen − offset) ÷ zoom`; the canvas applies `setTransform(zoom·dpr, …, offset·dpr)`.
// Pure math so the tests never touch a DOM.

export interface Camera {
  zoom: number;
  /** Screen-pixel translation applied after scaling; Figma space → screen space. */
  offsetX: number;
  offsetY: number;
}

export interface Point {
  x: number;
  y: number;
}

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 64;

/** Below this zoom the canvas draws cached raster thumbnails instead of vectors. */
export const THUMBNAIL_ZOOM = 0.15;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function screenToFigma(camera: Camera, point: Point): Point {
  return {
    x: (point.x - camera.offsetX) / camera.zoom,
    y: (point.y - camera.offsetY) / camera.zoom,
  };
}

export function figmaToScreen(camera: Camera, point: Point): Point {
  return {
    x: point.x * camera.zoom + camera.offsetX,
    y: point.y * camera.zoom + camera.offsetY,
  };
}

/** Zoom by `factor` keeping the Figma point under `cursor` (screen px) fixed. */
export function zoomAroundPoint(camera: Camera, factor: number, cursor: Point): Camera {
  const anchor = screenToFigma(camera, cursor);
  const zoom = clampZoom(camera.zoom * factor);
  return { zoom, offsetX: cursor.x - anchor.x * zoom, offsetY: cursor.y - anchor.y * zoom };
}

export function panBy(camera: Camera, dx: number, dy: number): Camera {
  return { zoom: camera.zoom, offsetX: camera.offsetX + dx, offsetY: camera.offsetY + dy };
}

/** The Figma-space rectangle currently visible in a `width`×`height` viewport. */
export function visibleRect(camera: Camera, width: number, height: number): FigmaRect {
  const topLeft = screenToFigma(camera, { x: 0, y: 0 });
  const bottomRight = screenToFigma(camera, { x: width, y: height });
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: bottomRight.x - topLeft.x,
    height: bottomRight.y - topLeft.y,
  };
}

export function rectsIntersect(a: FigmaRect, b: FigmaRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Frames whose bounds intersect the visible rect, grown by `marginPx` screen pixels. */
export function framesInViewport(
  frames: readonly FigmaFrameSummary[],
  camera: Camera,
  width: number,
  height: number,
  marginPx = 0,
): FigmaFrameSummary[] {
  const margin = marginPx / camera.zoom;
  const visible = visibleRect(camera, width, height);
  const view: FigmaRect = {
    x: visible.x - margin,
    y: visible.y - margin,
    width: visible.width + margin * 2,
    height: visible.height + margin * 2,
  };
  return frames.filter((frame) => rectsIntersect(frame.bounds, view));
}

/** Union of frame bounds, or null when there is nothing to fit. */
export function framesBoundingRect(frames: readonly { bounds: FigmaRect }[]): FigmaRect | null {
  if (frames.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const frame of frames) {
    minX = Math.min(minX, frame.bounds.x);
    minY = Math.min(minY, frame.bounds.y);
    maxX = Math.max(maxX, frame.bounds.x + frame.bounds.width);
    maxY = Math.max(maxY, frame.bounds.y + frame.bounds.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function centerCameraOn(
  camera: Camera,
  rect: FigmaRect,
  width: number,
  height: number,
): Camera {
  return {
    zoom: camera.zoom,
    offsetX: width / 2 - (rect.x + rect.width / 2) * camera.zoom,
    offsetY: height / 2 - (rect.y + rect.height / 2) * camera.zoom,
  };
}

/** The "Fit" button: the whole content scaled into the viewport with padding. */
export function cameraToFit(
  rect: FigmaRect | null,
  width: number,
  height: number,
  padding = 40,
): Camera {
  if (!rect || rect.width <= 0 || rect.height <= 0 || width <= 0 || height <= 0) {
    return { zoom: 1, offsetX: width / 2, offsetY: height / 2 };
  }
  const zoom = clampZoom(
    Math.min((width - padding * 2) / rect.width, (height - padding * 2) / rect.height),
  );
  return {
    zoom,
    offsetX: width / 2 - (rect.x + rect.width / 2) * zoom,
    offsetY: height / 2 - (rect.y + rect.height / 2) * zoom,
  };
}

/** The "100%" button: zoom 1, the content centered. */
export function cameraAt100(rect: FigmaRect | null, width: number, height: number): Camera {
  if (!rect) return { zoom: 1, offsetX: width / 2, offsetY: height / 2 };
  return {
    zoom: 1,
    offsetX: width / 2 - (rect.x + rect.width / 2),
    offsetY: height / 2 - (rect.y + rect.height / 2),
  };
}

/** Level of detail for a zoom: thumbnails keep pan/zoom at ≥ 50 fps on big files. */
export function lodMode(zoom: number): "thumbnail" | "vector" {
  return zoom < THUMBNAIL_ZOOM ? "thumbnail" : "vector";
}
