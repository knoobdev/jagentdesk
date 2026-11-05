import { useCallback, useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import {
  Component as ComponentIcon,
  Copy,
  Frame,
  Layers,
  PenTool,
  Shapes,
  Square,
  Trash2,
  Type,
  Zap,
} from "lucide-react-native";
import type { FigmaNode, FigmaPage } from "@jagentdesk/protocol/figma/rpc-schemas";
import { Button } from "@/components/ui/button";
import { jiraStyles } from "@/jira/ui/styles";
import type { ApplyFigmaEdits, FigmaSelection } from "../contracts";
import {
  createComponentOp,
  createInstanceOp,
  createNodeOp,
  deleteOp,
  duplicateOp,
  placementForCreate,
  setReactionOp,
  toggleLockOp,
  toggleVisibleOp,
} from "./ops";
import { type Camera, visibleRect } from "./viewport";

// Edit toolbar (spec 32.6): the one-click side of editing. Everything here builds FigmaEditOps
// and hands them to applyEdits — Figma Link when the file is open there, the pending queue
// otherwise (32.6.1). The queue controls live here because the screen owns the edit flow.

export interface EditToolbarProps {
  page: FigmaPage | null;
  selection: FigmaSelection | null;
  node: FigmaNode | null;
  camera: Camera;
  size: { width: number; height: number };
  applyEdits: ApplyFigmaEdits;
  linked: boolean;
  pendingCount: number;
  onApplyPending: () => void;
  onDiscardPending: () => void;
  disabled?: boolean;
}

const styles = StyleSheet.create({
  bar: { paddingHorizontal: 8, paddingVertical: 6 },
  pendingCount: { color: "inherit" },
});

let tempCounter = 0;
function nextTempId(): string {
  tempCounter += 1;
  return `tmp-${Date.now().toString(36)}-${tempCounter}`;
}

type Apply = (ops: Parameters<ApplyFigmaEdits>[0]) => void;
type Place = (width: number, height: number) => { x: number; y: number };

function SelectionActions({
  node,
  frames,
  parentForCreate,
  disabled,
  apply,
  place,
}: {
  node: FigmaNode;
  frames: readonly { id: string; name: string }[];
  parentForCreate: string;
  disabled?: boolean;
  apply: Apply;
  place: Place;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reactionOpen, setReactionOpen] = useState(false);

  // Any committed op also closes the confirm/reaction popovers.
  const applyAndClose = useCallback(
    (ops: Parameters<ApplyFigmaEdits>[0]) => {
      setConfirmDelete(false);
      setReactionOpen(false);
      apply(ops);
    },
    [apply],
  );

  const toggleVisibility = useCallback(
    () => applyAndClose([toggleVisibleOp(node)]),
    [applyAndClose, node],
  );
  const toggleLock = useCallback(() => applyAndClose([toggleLockOp(node)]), [applyAndClose, node]);
  const duplicate = useCallback(
    () => applyAndClose([duplicateOp(node.id, nextTempId())]),
    [applyAndClose, node.id],
  );
  const confirmYes = useCallback(
    () => applyAndClose([deleteOp(node.id)]),
    [applyAndClose, node.id],
  );
  const confirmNo = useCallback(() => setConfirmDelete(false), []);
  const askDelete = useCallback(() => setConfirmDelete(true), []);
  const makeComponent = useCallback(
    () => applyAndClose([createComponentOp(node.id, nextTempId())]),
    [applyAndClose, node.id],
  );
  const toggleReaction = useCallback(() => setReactionOpen((open) => !open), []);
  const makeInstance = useCallback(() => {
    const at = place(140, 140);
    applyAndClose([
      createInstanceOp({
        componentId: node.id,
        parentId: parentForCreate,
        x: at.x,
        y: at.y,
        tempId: nextTempId(),
      }),
    ]);
  }, [applyAndClose, place, node.id, parentForCreate]);

  const isComponent = String(node.type) === "COMPONENT";
  const hidden = node.visible === false;
  const locked = node.locked === true;

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        leftIcon={Layers}
        onPress={toggleVisibility}
        disabled={disabled}
        accessibilityLabel="Toggle visibility"
      >
        {hidden ? "Show" : "Hide"}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        leftIcon={Zap}
        onPress={toggleLock}
        disabled={disabled}
        accessibilityLabel="Toggle lock"
      >
        {locked ? "Unlock" : "Lock"}
      </Button>
      <Button size="sm" variant="ghost" leftIcon={Copy} onPress={duplicate} disabled={disabled}>
        Duplicate
      </Button>
      {confirmDelete ? (
        <View style={jiraStyles.row}>
          <Text style={jiraStyles.textMuted}>Delete?</Text>
          <Button size="sm" variant="destructive" onPress={confirmYes}>
            Yes
          </Button>
          <Button size="sm" variant="ghost" onPress={confirmNo}>
            No
          </Button>
        </View>
      ) : (
        <Button size="sm" variant="ghost" leftIcon={Trash2} onPress={askDelete} disabled={disabled}>
          Delete
        </Button>
      )}
      {isComponent ? (
        <Button
          size="sm"
          variant="ghost"
          leftIcon={ComponentIcon}
          onPress={makeInstance}
          disabled={disabled}
        >
          Instance
        </Button>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          leftIcon={ComponentIcon}
          onPress={makeComponent}
          disabled={disabled}
        >
          Component
        </Button>
      )}
      <Button size="sm" variant="ghost" leftIcon={Zap} onPress={toggleReaction} disabled={disabled}>
        Reaction
      </Button>
      {reactionOpen ? <ReactionPicker node={node} frames={frames} apply={applyAndClose} /> : null}
    </>
  );
}

function ReactionButton({
  node,
  destinationId,
  label,
  apply,
}: {
  node: FigmaNode;
  destinationId: string | null;
  label: string;
  apply: Apply;
}) {
  const onPress = useCallback(
    () => apply([setReactionOp({ nodeId: node.id, trigger: "ON_CLICK", destinationId })]),
    [apply, node.id, destinationId],
  );
  return (
    <Button size="xs" variant="ghost" onPress={onPress}>
      {label}
    </Button>
  );
}

function ReactionPicker({
  node,
  frames,
  apply,
}: {
  node: FigmaNode;
  frames: readonly { id: string; name: string }[];
  apply: Apply;
}) {
  return (
    <View style={jiraStyles.rowWrap}>
      {frames.slice(0, 8).map((frame) => (
        <ReactionButton
          key={frame.id}
          node={node}
          destinationId={frame.id}
          label={`→ ${frame.name}`}
          apply={apply}
        />
      ))}
      <ReactionButton node={node} destinationId={null} label="None" apply={apply} />
    </View>
  );
}

export function EditToolbar({
  page,
  selection,
  node,
  camera,
  size,
  applyEdits,
  linked,
  pendingCount,
  onApplyPending,
  onDiscardPending,
  disabled,
}: EditToolbarProps) {
  const apply = useCallback(
    (ops: Parameters<ApplyFigmaEdits>[0]) => {
      void applyEdits(ops).catch(() => undefined);
    },
    [applyEdits],
  );

  const place = useCallback(
    (width: number, height: number) =>
      placementForCreate(visibleRect(camera, size.width, size.height), { width, height }),
    [camera, size],
  );
  const parentForCreate = selection?.pageId ?? page?.id ?? "";

  const create = useCallback(
    (kind: "FRAME" | "TEXT" | "RECTANGLE") => {
      const defaults =
        kind === "TEXT"
          ? { width: 200, height: 24, characters: "Text" }
          : { width: 240, height: 140, characters: undefined };
      const at = place(defaults.width, defaults.height);
      apply([
        createNodeOp({
          parentId: parentForCreate,
          kind,
          tempId: nextTempId(),
          x: at.x,
          y: at.y,
          width: defaults.width,
          height: defaults.height,
          name: kind.charAt(0) + kind.slice(1).toLowerCase(),
          characters: defaults.characters,
        }),
      ]);
    },
    [apply, parentForCreate, place],
  );

  const createFrame = useCallback(() => create("FRAME"), [create]);
  const createText = useCallback(() => create("TEXT"), [create]);
  const createRect = useCallback(() => create("RECTANGLE"), [create]);
  const createGroup = useCallback(() => {
    if (!node) return;
    const at = place(240, 140);
    apply([
      createNodeOp({
        parentId: parentForCreate,
        kind: "FRAME",
        tempId: nextTempId(),
        x: at.x,
        y: at.y,
        width: 240,
        height: 140,
        name: `Copy of ${String(node.name ?? "frame")}`,
      }),
    ]);
  }, [apply, place, parentForCreate, node]);

  const frames = useMemo(() => page?.frames ?? [], [page]);

  return (
    <View style={[jiraStyles.row, styles.bar]} testID="figma-edit-toolbar">
      {node ? (
        <SelectionActions
          node={node}
          frames={frames}
          parentForCreate={parentForCreate}
          disabled={disabled}
          apply={apply}
          place={place}
        />
      ) : null}

      <View style={jiraStyles.spacer} />

      <Button size="sm" variant="ghost" leftIcon={Frame} onPress={createFrame} disabled={disabled}>
        Frame
      </Button>
      <Button size="sm" variant="ghost" leftIcon={Type} onPress={createText} disabled={disabled}>
        Text
      </Button>
      <Button size="sm" variant="ghost" leftIcon={Square} onPress={createRect} disabled={disabled}>
        Rect
      </Button>
      <Button
        size="sm"
        variant="ghost"
        leftIcon={Shapes}
        onPress={createGroup}
        disabled={disabled || !node}
      >
        Group
      </Button>

      <View style={jiraStyles.row}>
        {pendingCount > 0 ? (
          <Text style={[jiraStyles.textSmall, styles.pendingCount]} testID="figma-pending-count">
            {`${pendingCount} pending`}
          </Text>
        ) : null}
        {pendingCount > 0 && linked ? (
          <Button size="sm" variant="outline" leftIcon={PenTool} onPress={onApplyPending}>
            Apply
          </Button>
        ) : null}
        {pendingCount > 0 ? (
          <Button size="sm" variant="ghost" onPress={onDiscardPending}>
            Discard
          </Button>
        ) : null}
      </View>
    </View>
  );
}
