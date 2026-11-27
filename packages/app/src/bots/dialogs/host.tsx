// Renders the one open bots dialog (`dialogs-store.ts`). Mounted once by the bot page and the sidebar.
// Moving between dialogs (Templates → New bot, Hand to bot → New bot…) replaces the open one, so each
// opens fresh (docs/forms.md rule 1: a key per open).
import { useCallback, useEffect } from "react";
import { useBotsDialogs, type BotsDialog } from "@/bots/dialogs-store";
import { useBotShareSlot } from "@/bots/share-slot";
import { BotGroupDialog } from "./group-dialog";
import { HandToBotFlow } from "./hand-to-bot";
import { NewBotDialog } from "./new-bot-dialog";
import { BotTemplatesDialog } from "./templates-dialog";

function dialogKey(dialog: BotsDialog): string {
  switch (dialog.kind) {
    case "newBot":
      return `newBot:${dialog.serverId}:${dialog.templateId ?? ""}:${dialog.handOver?.workspaceId ?? ""}`;
    case "templates":
      return `templates:${dialog.serverId}`;
    case "handToBot":
      return `handToBot:${dialog.serverId}:${dialog.workspaceId}`;
    case "group":
      return `group:${dialog.serverId}:${dialog.roomId ?? ""}`;
    case "shareLink":
      return `shareLink:${dialog.serverId}`;
  }
}

export function BotsDialogsHost() {
  const dialog = useBotsDialogs((state) => state.dialog);
  if (!dialog) return null;
  return <OpenDialog key={dialogKey(dialog)} dialog={dialog} />;
}

function OpenDialog({ dialog }: { dialog: BotsDialog }) {
  const close = useBotsDialogs((state) => state.close);
  const open = useBotsDialogs((state) => state.open);
  const serverId = dialog.serverId;
  const openTemplates = useCallback(() => open({ kind: "templates", serverId }), [open, serverId]);
  const applyTemplate = useCallback(
    (templateId: string) => open({ kind: "newBot", serverId, templateId }),
    [open, serverId],
  );
  const blankBot = useCallback(() => open({ kind: "newBot", serverId }), [open, serverId]);
  const handOverToNew = useCallback(
    (goal: string) => {
      if (dialog.kind !== "handToBot") return;
      open({
        kind: "newBot",
        serverId,
        handOver: {
          workspaceId: dialog.workspaceId,
          name: dialog.name,
          ...(goal ? { goal } : {}),
        },
      });
    },
    [dialog, open, serverId],
  );
  switch (dialog.kind) {
    case "newBot":
      return (
        <NewBotDialog
          serverId={serverId}
          templateId={dialog.templateId}
          handOver={dialog.handOver}
          onClose={close}
          onOpenTemplates={openTemplates}
        />
      );
    case "templates":
      return (
        <BotTemplatesDialog
          serverId={serverId}
          initialQuery={dialog.query}
          onClose={close}
          onUse={applyTemplate}
          onBlank={blankBot}
        />
      );
    case "handToBot":
      return (
        <HandToBotFlow
          serverId={serverId}
          workspaceId={dialog.workspaceId}
          name={dialog.name}
          onClose={close}
          onNewBot={handOverToNew}
        />
      );
    case "group":
      return <BotGroupDialog serverId={serverId} roomId={dialog.roomId} onClose={close} />;
    case "shareLink":
      return <ShareLinkDialog serverId={serverId} onClose={close} />;
  }
}

/** "From a link…" is bt5's (spec 37.13.3): its registered component, else nothing. */
function ShareLinkDialog({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const Receive = useBotShareSlot((state) => state.Receive);
  useEffect(() => {
    if (!Receive) onClose();
  }, [Receive, onClose]);
  return Receive ? <Receive serverId={serverId} onClose={onClose} /> : null;
}
