import { EventEmitter } from "node:events";
import { describe, expect, test, vi } from "vitest";
import {
  answerDialog,
  drainDialogEvents,
  getPendingDialog,
  installGuestDialogHandler,
  onDialogsChanged,
  openGuestPrompt,
} from "./guest-dialogs.js";

class FakeGuest extends EventEmitter {
  public constructor(public readonly id: number) {
    super();
    // Electron's own handler, which shows a native message box.
    this.on("-run-dialog", () => {
      throw new Error("native dialog shown");
    });
  }

  public getURL(): string {
    return "http://localhost:4000/";
  }

  public isDestroyed(): boolean {
    return false;
  }

  public openDialog(info: Record<string, unknown>) {
    const respond = vi.fn();
    this.emit("-run-dialog", info, respond);
    return respond;
  }
}

describe("guest dialogs", () => {
  test("replaces the native dialog with a pending dialog the page waits on", () => {
    const guest = new FakeGuest(101);
    installGuestDialogHandler(guest);
    installGuestDialogHandler(guest);

    const respond = guest.openDialog({ dialogType: "alert", messageText: "Saved" });

    expect(guest.listenerCount("-run-dialog")).toBe(1);
    expect(getPendingDialog(101)).toMatchObject({
      type: "alert",
      message: "Saved",
      url: "http://localhost:4000/",
    });
    expect(respond).not.toHaveBeenCalled();
  });

  test("a prompt receives the text the agent enters", () => {
    const guest = new FakeGuest(102);
    installGuestDialogHandler(guest);
    const respond = guest.openDialog({
      dialogType: "prompt",
      messageText: "Your name?",
      defaultPromptText: "guest",
    });

    expect(getPendingDialog(102)).toMatchObject({ type: "prompt", defaultValue: "guest" });
    expect(answerDialog(102, { action: "accept", text: "Ada", by: "agent" })).toMatchObject({
      action: "accepted",
      promptText: "Ada",
    });
    expect(respond).toHaveBeenCalledWith(true, "Ada");
    // The agent's own answer is in its tool result, not replayed later.
    expect(drainDialogEvents(102)).toEqual([]);
  });

  test("the first answer wins and a user's answer is reported to the agent", () => {
    const guest = new FakeGuest(103);
    installGuestDialogHandler(guest);
    const respond = guest.openDialog({ dialogType: "confirm", messageText: "Delete item?" });

    expect(answerDialog(103, { action: "accept", by: "user" })).toMatchObject({
      action: "accepted",
    });
    expect(answerDialog(103, { action: "dismiss", by: "agent" })).toBeNull();
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(true, "");
    expect(drainDialogEvents(103)).toMatchObject([
      { type: "confirm", message: "Delete item?", action: "accepted" },
    ]);
  });

  test("navigation cancels the pending dialog and notifies the dialog bar", () => {
    const guest = new FakeGuest(104);
    installGuestDialogHandler(guest);
    const changes: Array<unknown> = [];
    const unsubscribe = onDialogsChanged((change) => changes.push(change));

    guest.openDialog({ dialogType: "confirm", messageText: "Continue?" });
    guest.emit("-cancel-dialogs");
    unsubscribe();

    expect(getPendingDialog(104)).toBeNull();
    expect(changes).toMatchObject([
      { contentsId: 104, pendingDialog: { type: "confirm" } },
      { contentsId: 104, pendingDialog: null },
    ]);
  });

  test("a main-frame prompt relayed by the guest preload waits for an answer", () => {
    const guest = new FakeGuest(106);
    const respond = vi.fn();

    expect(openGuestPrompt(guest, { message: "Code?", defaultValue: "PRJ-000" }, respond)).toBe(
      false,
    );
    installGuestDialogHandler(guest);
    expect(openGuestPrompt(guest, { message: "Code?", defaultValue: "PRJ-000" }, respond)).toBe(
      true,
    );
    expect(getPendingDialog(106)).toMatchObject({ type: "prompt", defaultValue: "PRJ-000" });

    answerDialog(106, { action: "accept", by: "agent" });
    expect(respond).toHaveBeenCalledWith(true, "PRJ-000");
  });

  test("navigation releases a page blocked on a prompt", () => {
    const guest = new FakeGuest(107);
    installGuestDialogHandler(guest);
    const respond = vi.fn();
    openGuestPrompt(guest, { message: "Code?", defaultValue: "" }, respond);

    guest.emit("-cancel-dialogs");

    expect(respond).toHaveBeenCalledWith(false, "");
    expect(getPendingDialog(107)).toBeNull();
  });

  test("beforeunload leaves the page and is reported", () => {
    const guest = new FakeGuest(105);
    installGuestDialogHandler(guest);
    const event = { preventDefault: vi.fn() };

    guest.emit("will-prevent-unload", event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(drainDialogEvents(105)).toMatchObject([{ type: "beforeunload", action: "accepted" }]);
  });
});
