import { useId } from "react";
import { useComposerKeyboardScope } from "@/composer/keyboard-scope";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import { resolveNextChoiceId } from "./mode";

export function useModelPickerShortcut(disabled: boolean) {
  const { isActiveComposer, isInputFocused } = useComposerKeyboardScope();
  return isActiveComposer && !disabled
    ? {
        id: "message-input.model-toggle" as const,
        canOpen: () => isInputFocused,
      }
    : undefined;
}

export function useEffortCycleShortcut(
  options: readonly { id: string }[],
  selectedId: string | undefined,
  onSelect: ((id: string) => void) | undefined,
  disabled: boolean,
) {
  const { isActiveComposer, isInputFocused } = useComposerKeyboardScope();
  const handlerId = useId();
  const nextId = resolveNextChoiceId(options, selectedId);
  useKeyboardActionHandler({
    handlerId,
    actions: ["message-input.effort-cycle"],
    enabled: isActiveComposer && !disabled && nextId !== null && !!onSelect,
    isActive: () => isInputFocused,
    priority: 200,
    handle: () => {
      if (!onSelect || nextId === null) return false;
      onSelect(nextId);
      return true;
    },
  });
}
