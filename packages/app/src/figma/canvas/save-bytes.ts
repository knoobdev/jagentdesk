import type { FigmaBytes } from "@jagentdesk/protocol/figma/rpc-schemas";
import { isWeb } from "@/constants/platform";

// Save the bytes `figma.file.export` returned (32.5.2). Web downloads a data URL; native writes a
// cache file and hands it to the share sheet, the same shape downloads use in download-store.

function webDownload(bytes: FigmaBytes, fileName: string): void {
  const link = document.createElement("a");
  link.href = `data:${bytes.mimeType};base64,${bytes.dataBase64}`;
  link.download = fileName;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function nativeShare(bytes: FigmaBytes, fileName: string): Promise<void> {
  const LegacyFileSystem = await import("expo-file-system/legacy");
  const Sharing = await import("expo-sharing");
  const uri = `${LegacyFileSystem.documentDirectory}${fileName}`;
  await LegacyFileSystem.writeAsStringAsync(uri, bytes.dataBase64, { encoding: "base64" });
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, { mimeType: bytes.mimeType, dialogTitle: fileName });
  }
}

export async function saveExportedBytes(bytes: FigmaBytes, fileName: string): Promise<void> {
  if (isWeb) {
    webDownload(bytes, fileName);
    return;
  }
  await nativeShare(bytes, fileName);
}
