// Briefly highlights the transcript row an activity-graph node points at (spec 31.4). Uses the Web
// Animations API on the row element, so no React state changes and nothing re-renders.
const FLASH_COLOR = "rgba(59, 130, 246, 0.22)"; // running blue #3b82f6, design system §1.4

export function flashTimelineRow(itemId: string): void {
  if (typeof document === "undefined") return;
  const row = document.querySelector<HTMLElement>(`[data-history-row-id="${CSS.escape(itemId)}"]`);
  if (!row || typeof row.animate !== "function") return;
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  row.setAttribute("data-activity-flash", "true");
  const animation = row.animate(
    reduceMotion
      ? [{ backgroundColor: FLASH_COLOR }, { backgroundColor: FLASH_COLOR }]
      : [
          { backgroundColor: "transparent" },
          { backgroundColor: FLASH_COLOR, offset: 0.2 },
          { backgroundColor: "transparent" },
        ],
    { duration: reduceMotion ? 900 : 1400, easing: "ease-out" },
  );
  animation.onfinish = () => row.removeAttribute("data-activity-flash");
}
