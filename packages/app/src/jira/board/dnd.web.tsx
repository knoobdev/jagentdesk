import { useCallback, useMemo, type CSSProperties } from "react";
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import type { DndProviderProps, DraggableProps, DropZoneProps } from "./dnd.types";

// Web drag and drop. Pointer collisions prefer an item (rank before it) over the zone around it.

export const ITEM_PREFIX = "item:";

const ZONE_STYLE: CSSProperties = { display: "flex", flexDirection: "column" };

const preferItems: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  const items = hits.filter((hit) => String(hit.id).startsWith(ITEM_PREFIX));
  return items.length > 0 ? items : hits;
};

export function DndProvider({ children, onDrop }: DndProviderProps) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
  );
  const handleEnd = useCallback(
    (event: DragEndEvent) => {
      if (!event.over) return;
      const dragId = String(event.active.id).slice(ITEM_PREFIX.length);
      const dropId = String(event.over.id);
      if (dropId === String(event.active.id)) return;
      onDrop(dragId, dropId.startsWith(ITEM_PREFIX) ? dropId.slice(ITEM_PREFIX.length) : dropId);
    },
    [onDrop],
  );
  return (
    <DndContext sensors={sensors} collisionDetection={preferItems} onDragEnd={handleEnd}>
      {children}
    </DndContext>
  );
}

export function Draggable({ id, children }: DraggableProps) {
  const dragId = `${ITEM_PREFIX}${id}`;
  const drag = useDraggable({ id: dragId });
  const drop = useDroppable({ id: dragId });
  const setRef = useCallback(
    (node: HTMLElement | null) => {
      drag.setNodeRef(node);
      drop.setNodeRef(node);
    },
    [drag, drop],
  );
  const style = useMemo<CSSProperties>(
    () => ({
      transform: CSS.Translate.toString(drag.transform),
      zIndex: drag.isDragging ? 1000 : undefined,
      opacity: drag.isDragging ? 0.85 : 1,
      position: "relative",
      alignSelf: "stretch",
      boxShadow: drop.isOver && !drag.isDragging ? "inset 0 2px 0 0 currentColor" : undefined,
      touchAction: "manipulation",
    }),
    [drag.transform, drag.isDragging, drop.isOver],
  );
  return (
    <div ref={setRef} style={style} {...drag.attributes} {...drag.listeners}>
      {children}
    </div>
  );
}

export function DropZone({ id, children }: DropZoneProps) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div ref={setNodeRef} style={ZONE_STYLE}>
      {children(isOver)}
    </div>
  );
}

export const dragAndDropAvailable = true;
