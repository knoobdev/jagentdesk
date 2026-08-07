import { describe, expect, it, vi } from "vitest";
import {
  clearSidebarCallouts,
  createSidebarCalloutState,
  dismissSidebarCallout,
  loadDismissedCalloutKeys,
  parseDismissedCalloutKeys,
  selectActiveSidebarCallout,
  serializeDismissedCalloutKeys,
  showSidebarCallout,
  unregisterSidebarCallout,
} from "./sidebar-callout-state";

describe("sidebar callout state", () => {
  it("shows the highest-priority callout first, then reveals the next when dismissed", () => {
    let state = createSidebarCalloutState();
    state = showSidebarCallout(state, {
      id: "onboarding",
      priority: 10,
      title: "Set up scripts",
    }).state;
    state = showSidebarCallout(state, {
      id: "notice",
      priority: 200,
      title: "Notice available",
    }).state;

    expect(selectActiveSidebarCallout(state)?.title).toBe("Notice available");

    state = dismissSidebarCallout(state, "notice").state;

    expect(selectActiveSidebarCallout(state)?.title).toBe("Set up scripts");
  });

  it("replaces a callout by id without duplicating the queue item", () => {
    let state = createSidebarCalloutState();
    state = showSidebarCallout(state, {
      id: "daemon",
      title: "Old daemon",
      description: "v1",
    }).state;
    state = showSidebarCallout(state, {
      id: "daemon",
      title: "New daemon",
      description: "v2",
    }).state;

    expect(state.callouts).toMatchObject([
      {
        id: "daemon",
        title: "New daemon",
        description: "v2",
      },
    ]);
  });

  it("unregisters only the registration returned by show", () => {
    let state = createSidebarCalloutState();
    const oldRegistration = showSidebarCallout(state, { id: "notice", title: "Old" });
    state = oldRegistration.state;
    state = showSidebarCallout(state, { id: "notice", title: "New" }).state;

    state = unregisterSidebarCallout(state, { id: "notice", token: oldRegistration.token });

    expect(selectActiveSidebarCallout(state)?.title).toBe("New");
  });

  it("persists dismissals by dismissal key and hides matching future callouts", () => {
    const onDismiss = vi.fn();
    let state = loadDismissedCalloutKeys(createSidebarCalloutState(), new Set());
    state = showSidebarCallout(state, {
      id: "notice",
      dismissalKey: "notice:available:1.2.3",
      title: "Notice available",
      onDismiss,
    }).state;

    const result = dismissSidebarCallout(state, "notice");
    state = result.state;

    expect(result.dismissalKey).toBe("notice:available:1.2.3");
    expect(serializeDismissedCalloutKeys(state.dismissedKeys)).toBe(
      JSON.stringify(["notice:available:1.2.3"]),
    );
    expect(onDismiss).not.toHaveBeenCalled();
    result.dismissedCallout?.onDismiss?.();
    expect(onDismiss).toHaveBeenCalledOnce();

    state = showSidebarCallout(state, {
      id: "notice",
      dismissalKey: "notice:available:1.2.3",
      title: "Dismissed notice",
    }).state;

    expect(selectActiveSidebarCallout(state)).toBeNull();

    state = showSidebarCallout(state, {
      id: "notice",
      dismissalKey: "notice:available:1.2.4",
      title: "New notice",
    }).state;

    expect(selectActiveSidebarCallout(state)?.title).toBe("New notice");
  });

  it("waits for dismissal storage before showing dismissible callouts", () => {
    let state = createSidebarCalloutState();
    state = showSidebarCallout(state, {
      id: "notice",
      dismissalKey: "notice:available:1.2.3",
      title: "Notice available",
    }).state;

    expect(selectActiveSidebarCallout(state)).toBeNull();

    state = loadDismissedCalloutKeys(state, new Set());

    expect(selectActiveSidebarCallout(state)?.title).toBe("Notice available");
  });

  it("parses stored dismissal keys defensively", () => {
    expect(parseDismissedCalloutKeys(JSON.stringify(["a", 4, "b"]))).toEqual(new Set(["a", "b"]));
    expect(parseDismissedCalloutKeys("{")).toEqual(new Set());
    expect(parseDismissedCalloutKeys(JSON.stringify({ key: "a" }))).toEqual(new Set());
  });

  it("clears visible callouts without dropping dismissal state", () => {
    let state = loadDismissedCalloutKeys(createSidebarCalloutState(), new Set(["dismissed"]));
    state = showSidebarCallout(state, { id: "visible", title: "Visible" }).state;

    state = clearSidebarCallouts(state);

    expect(state.callouts).toEqual([]);
    expect(state.dismissedKeys).toEqual(new Set(["dismissed"]));
  });
});
