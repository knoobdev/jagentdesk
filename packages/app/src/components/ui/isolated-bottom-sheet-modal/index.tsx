import { SheetBackdrop } from "./sheet-backdrop";
import {
  BottomSheetScope,
  type AttachSheetContentDrag,
  type SheetContentDragGesture,
} from "@/components/ui/bottom-sheet-scope";
import { useState } from "react";
import {
  BottomSheetModal as GorhomBottomSheetModal,
  type BottomSheetModalProps,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type ElementRef,
  type ReactNode,
} from "react";
import { systemBackPress } from "./back-press";
import {
  type BottomSheetController,
  createBottomSheetVisibilityTracker,
} from "./visibility-tracker";
import { useDismissibleOverlay } from "@/components/ui/overlay-dismissal";

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
  enableDismissOnClose?: boolean;
  backdropOpacity?: number;
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
    backdropOpacity,
    enableDismissOnClose = true,
    waitFor,
    simultaneousHandlers,
    ...bottomSheetProps
  } = props;
  const modalRef = useRef<GorhomBottomSheetModalMethods>(null);
  useImperativeHandle(
    ref,
    () => ({
      present: (...args) => modalRef.current?.present(...args),
      dismiss: (...args) => modalRef.current?.dismiss(...args),
      snapToIndex: (...args) => modalRef.current?.snapToIndex(...args),
      snapToPosition: (...args) => modalRef.current?.snapToPosition(...args),
      expand: (...args) => modalRef.current?.expand(...args),
      collapse: (...args) => modalRef.current?.collapse(...args),
      close: (...args) => modalRef.current?.close(...args),
      forceClose: (...args) => modalRef.current?.forceClose(...args),
    }),
    [],
  );
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

  const renderBackdrop = useCallback(
    (backdropProps: BottomSheetBackdropProps) => (
      <SheetBackdrop
        {...backdropProps}
        opacity={backdropOpacity}
        pressBehavior={enableDismissOnClose ? "dismiss" : "close"}
      />
    ),
    [backdropOpacity, enableDismissOnClose],
  );
  const modal = (
    <GorhomBottomSheetModal
      {...bottomSheetProps}
      ref={modalRef}
      backdropComponent={
        backdropOpacity === undefined ? bottomSheetProps.backdropComponent : renderBackdrop
      }
      enableDismissOnClose={enableDismissOnClose}
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
  useDismissibleOverlay(visible && isEnabled !== false, onClose);

  return {
    sheetRef: setSheetRef,
    handleSheetChange,
    handleSheetDismiss,
  };
}

export { systemBackPress } from "./back-press";
