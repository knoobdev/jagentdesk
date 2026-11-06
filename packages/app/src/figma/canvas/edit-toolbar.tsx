import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { errorMessage } from "./api";
import { EditFailureBanner } from "./edit-state-view";
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
// Missing Link never blocks these buttons: queued edits stay marked pending and are never
// presented as saved to the original file in Figma. A failed edit stays visible until retried
// or dismissed (docs/testing.md: fallible user actions).

export interface EditToolbarProps {
  page: FigmaPage | null;
  selection: FigmaSelection | null;
  node: FigmaNode | null;
  camera: Camera;
  size: { width: number; height: number };
  applyEdits: ApplyFigmaEdits;
  linked: boolean;
  pendingCount: number;
  // Both may reject (the queue RPC is async); the toolbar routes them through the same
  // failure surface as edits. file-screen currently wraps them in `void`, so today's
  // wiring resolves immediately — returning the promise there surfaces real failures.
  onApplyPending: () => void | Promise<unknown>;
  onDiscardPending: () => void | Promise<unknown>;
  disabled?: boolean;
}

const styles = StyleSheet.create({
  bar: { paddingHorizontal: 8, paddingVertical: 6 },
  pendingCount: { color: "inherit" },
  statusRow: { paddingHorizontal: 8, paddingBottom: 6 },
});

type EditStatus = { kind: "idle" } | { kind: "busy" } | { kind: "failed"; message: string };
const EDIT_IDLE: EditStatus = { kind: "idle" };

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
  const [status, setStatus] = useState<EditStatus>(EDIT_IDLE);
  const busy = status.kind === "busy";
  const controlsDisabled = Boolean(disabled) || busy;

  // One flight at a time (synchronous guard), completions keyed by sequence so a late
  // response can never clobber a newer one, and by inspect identity so an edit that fails
  // after the user moved to another layer doesn't strand its banner. The failed status
  // itself persists until retried or dismissed (docs/testing.md: fallible user actions).
  const submittingRef = useRef(false);
  const mountedRef = useRef(true);
  const seqRef = useRef(0);
  const parentForCreate = selection?.pageId ?? page?.id ?? "";
  const identity = `${parentForCreate}|${node?.id ?? ""}`;
  const identityRef = useRef(identity);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    identityRef.current = identity;
    setStatus((current) => (current.kind === "failed" ? EDIT_IDLE : current));
  }, [identity]);

  const submit = useCallback((run: () => unknown) => {
    if (submittingRef.current) return;
    const seq = (seqRef.current += 1);
    const identityAtSubmit = identityRef.current;
    submittingRef.current = true;
    setStatus({ kind: "busy" });
    const settle = (next: EditStatus) => {
      if (!mountedRef.current || seq !== seqRef.current) return;
      submittingRef.current = false;
      setStatus(identityAtSubmit === identityRef.current ? next : EDIT_IDLE);
    };
    void Promise.resolve()
      .then(run)
      .then(
        () => settle(EDIT_IDLE),
        (cause: unknown) => settle({ kind: "failed", message: errorMessage(cause) }),
      );
  }, []);

  const apply = useCallback(
    (ops: Parameters<ApplyFigmaEdits>[0]) => submit(() => applyEdits(ops)),
    [applyEdits, submit],
  );
  const dismissFailure = useCallback(() => setStatus(EDIT_IDLE), []);
  const applyPending = useCallback(() => submit(() => onApplyPending()), [submit, onApplyPending]);
  const discardPending = useCallback(
    () => submit(() => onDiscardPending()),
    [submit, onDiscardPending],
  );

  const place = useCallback(
    (width: number, height: number) =>
      placementForCreate(visibleRect(camera, size.width, size.height), { width, height }),
    [camera, size],
  );

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
    <View testID="figma-edit-toolbar-root">
      <View style={[jiraStyles.row, styles.bar]} testID="figma-edit-toolbar">
        {node ? (
          <SelectionActions
            node={node}
            frames={frames}
            parentForCreate={parentForCreate}
            disabled={controlsDisabled}
            apply={apply}
            place={place}
          />
        ) : null}

        <View style={jiraStyles.spacer} />

        <Button
          size="sm"
          variant="ghost"
          leftIcon={Frame}
          onPress={createFrame}
          disabled={controlsDisabled}
        >
          Frame
        </Button>
        <Button
          size="sm"
          variant="ghost"
          leftIcon={Type}
          onPress={createText}
          disabled={controlsDisabled}
        >
          Text
        </Button>
        <Button
          size="sm"
          variant="ghost"
          leftIcon={Square}
          onPress={createRect}
          disabled={controlsDisabled}
        >
          Rect
        </Button>
        <Button
          size="sm"
          variant="ghost"
          leftIcon={Shapes}
          onPress={createGroup}
          disabled={controlsDisabled || !node}
        >
          Group
        </Button>

        <View style={jiraStyles.row}>
          {busy ? (
            <Text style={jiraStyles.textSmall} testID="figma-edit-busy">
              Submitting…
            </Text>
          ) : null}
          {pendingCount > 0 ? (
            <Text style={[jiraStyles.textSmall, styles.pendingCount]} testID="figma-pending-count">
              {`${pendingCount} pending`}
            </Text>
          ) : null}
          {pendingCount > 0 && linked ? (
            <Button
              size="sm"
              variant="outline"
              leftIcon={PenTool}
              onPress={applyPending}
              disabled={controlsDisabled}
            >
              Apply
            </Button>
          ) : null}
          {pendingCount > 0 ? (
            <Button size="sm" variant="ghost" onPress={discardPending} disabled={controlsDisabled}>
              Discard
            </Button>
          ) : null}
        </View>
      </View>
      {status.kind === "failed" ? (
        <View style={styles.statusRow}>
          <EditFailureBanner message={status.message} onDismiss={dismissFailure} />
        </View>
      ) : null}
    </View>
  );
}
