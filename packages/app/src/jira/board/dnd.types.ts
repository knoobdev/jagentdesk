import type { ReactNode } from "react";

// Drag and drop for the board and the backlog. Web drags with @dnd-kit (dnd.web.tsx); native has
// no drag (dnd.tsx) and uses the "Move to…" sheets instead (spec 29.3: mobile "Move to…").
// Ids are strings the caller chooses; a draggable item is also a drop target (drop "on a card"
// ranks before it).

export interface DndProviderProps {
  children: ReactNode;
  onDrop: (dragId: string, dropId: string) => void;
}

export interface DraggableProps {
  id: string;
  children: ReactNode;
}

export interface DropZoneProps {
  id: string;
  children: (isOver: boolean) => ReactNode;
}
