import { useMemo } from "react";
import { Modal as NativeModal, Platform, useWindowDimensions, type ModalProps } from "react-native";
const orientations: NonNullable<ModalProps["supportedOrientations"]> = [
  "portrait",
  "portrait-upside-down",
  "landscape-left",
  "landscape-right",
];
export function Modal(props: ModalProps) {
  const { style } = props;
  const windowFrame = useAndroidWindowFrame();
  const containerStyle = useMemo(() => [windowFrame, style], [windowFrame, style]);
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
