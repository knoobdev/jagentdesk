import type { ReactNode } from "react";
import type { DndProviderProps, DraggableProps, DropZoneProps } from "./dnd.types";

// Native: no drag and drop; cards and rows move through their "Move to…" sheet.

export function DndProvider({ children }: DndProviderProps): ReactNode {
  return children;
}

export function Draggable({ children }: DraggableProps): ReactNode {
  return children;
}

export function DropZone({ children }: DropZoneProps): ReactNode {
  return children(false);
}

export const dragAndDropAvailable = false;
