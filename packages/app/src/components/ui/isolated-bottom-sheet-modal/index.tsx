import {
  BottomSheetScope,
  type AttachSheetContentDrag,
  type SheetContentDragGesture,
} from "@/components/ui/bottom-sheet-scope";
import { useState } from "react";
import {
  BottomSheetModal as GorhomBottomSheetModal,
  type BottomSheetModalProps,
} from "@gorhom/bottom-sheet";
import React from "react";
import { forwardRef, useCallback, useEffect, useMemo, useRef } from "react";
import type { ElementRef, ReactNode } from "react";
import { systemBackPress } from "./back-press";
import {
  type BottomSheetController,
  createBottomSheetVisibilityTracker,
} from "./visibility-tracker";

type GorhomBottomSheetModalMethods = ElementRef<typeof GorhomBottomSheetModal>;

/**
 * Gorhom renders sheet content in a portal outside the caller's React tree, so context
 * providers above the sheet are lost. A bridge re-wraps the content in the providers it needs.
 */
export type ContextBridge = (children: ReactNode) => ReactNode;

type IsolatedBottomSheetModalProps = Omit<
  BottomSheetModalProps,
  "enableDismissOnClose" | "stackBehavior" | "children"
> & {
  children?: ReactNode;
  presentation?: "push" | "replace";
  contextBridge?: ContextBridge | null;
};

export type IsolatedBottomSheetModalRef = GorhomBottomSheetModalMethods;

export const IsolatedBottomSheetModal = forwardRef<
  IsolatedBottomSheetModalRef,
  IsolatedBottomSheetModalProps
>(function IsolatedBottomSheetModal(props, ref) {
  const {
    children,
    presentation = "push",
    contextBridge,
    waitFor,
    simultaneousHandlers,
    ...bottomSheetProps
  } = props;
  const [contentDragGesture, setContentDragGesture] = useState<SheetContentDragGesture>();
  const attachContentDrag = useCallback<AttachSheetContentDrag>((gesture) => {
    setContentDragGesture(gesture);
    return () => setContentDragGesture((current) => (current === gesture ? undefined : current));
  }, []);
  // RNGH Android's shouldBeCancelledByActiveHandler treats a waiting ancestor's raw ACTIVE
  // state as ownership and cancels its child at activation. Simultaneity lets the child activate;
  // waitFor still keeps the sheet stationary until the child fails.
  const contentDragHandlers = useMemo(() => {
    if (!contentDragGesture) return { waitFor, simultaneousHandlers };
    return {
      waitFor: [...(waitFor ? [waitFor].flat() : []), contentDragGesture],
      simultaneousHandlers: [
        ...(simultaneousHandlers ? [simultaneousHandlers].flat() : []),
        contentDragGesture,
      ],
    };
  }, [contentDragGesture, waitFor, simultaneousHandlers]);

  const modal = (
    <GorhomBottomSheetModal
      {...bottomSheetProps}
      ref={ref}
      enableDismissOnClose
      stackBehavior={presentation}
      waitFor={contentDragHandlers.waitFor}
      simultaneousHandlers={contentDragHandlers.simultaneousHandlers}
    >
      <BottomSheetScope attachContentDrag={attachContentDrag}>
        {contextBridge ? contextBridge(children) : children}
      </BottomSheetScope>
    </GorhomBottomSheetModal>
  );

  return modal;
});

export function useIsolatedBottomSheetVisibility({
  visible,
  isEnabled,
  onClose,
}: {
  visible: boolean;
  isEnabled?: boolean;
  onClose: () => void;
}) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const tracker = useMemo(
    () =>
      createBottomSheetVisibilityTracker({
        onClose: () => onCloseRef.current(),
        backPress: systemBackPress,
      }),
    [],
  );

  const setSheetRef = useCallback(
    (instance: IsolatedBottomSheetModalRef | null) => {
      tracker.attachController(instance as BottomSheetController | null);
    },
    [tracker],
  );

  const handleSheetChange = useCallback(
    (index: number) => tracker.handleSheetIndexChange(index),
    [tracker],
  );

  const handleSheetDismiss = useCallback(() => tracker.handleSheetDismiss(), [tracker]);

  useEffect(() => {
    tracker.syncDesired({ visible, isEnabled });
  }, [isEnabled, tracker, visible]);

  return {
    sheetRef: setSheetRef,
    handleSheetChange,
    handleSheetDismiss,
  };
}
