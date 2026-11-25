import { useMemo } from "react";
import {
  Modal as NativeModal,
  Platform,
  useWindowDimensions,
  type ModalProps as NativeModalProps,
} from "react-native";
import { useDismissibleOverlay } from "@/components/ui/overlay-dismissal";

// React Native defaults iPhone modals to portrait even when the app supports rotation.
const orientations: NonNullable<NativeModalProps["supportedOrientations"]> = [
  "portrait",
  "portrait-upside-down",
  "landscape-left",
  "landscape-right",
];

type ModalProps = Omit<NativeModalProps, "onRequestClose"> & {
  /** Back, Escape, and a composer taking focus all close the modal through this. */
  onRequestClose?: () => void;
};

function noClose() {}

export function Modal(props: ModalProps) {
  const { visible = true, onRequestClose, style } = props;
  const windowFrame = useAndroidWindowFrame();
  const containerStyle = useMemo(() => [windowFrame, style], [windowFrame, style]);
  useDismissibleOverlay(visible && onRequestClose !== undefined, onRequestClose ?? noClose);
  return <NativeModal supportedOrientations={orientations} {...props} style={containerStyle} />;
}

// RN's initial Android dialog bounds exclude the system bars before the first layout report.
function useAndroidWindowFrame() {
  const { width, height } = useWindowDimensions();
  return useMemo(
    () => (Platform.OS === "android" ? { flex: 0, width, height } : null),
    [width, height],
  );
}
