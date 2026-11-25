import { Platform, ToastAndroid } from "react-native";

export function showNativeToast(message: string, durationMs: number | null): boolean {
  if (Platform.OS !== "android") return false;
  const duration =
    durationMs !== null && durationMs <= 2500 ? ToastAndroid.SHORT : ToastAndroid.LONG;
  ToastAndroid.showWithGravity(message, duration, ToastAndroid.TOP);
  return true;
}
