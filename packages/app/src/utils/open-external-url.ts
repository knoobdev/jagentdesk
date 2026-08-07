import * as Linking from "expo-linking";
import { getDesktopHost } from "@/desktop/host";
import { isWeb } from "@/constants/platform";

const ALLOWED_EXTERNAL_URL_PROTOCOLS = new Set(["http:", "https:"]);

function isAllowedExternalUrl(url: string): boolean {
  try {
    return ALLOWED_EXTERNAL_URL_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

export async function openExternalUrl(url: string): Promise<void> {
  // Validate before handing the URL to Electron's opener IPC. Custom app
  // schemes and placeholders from old screens must never reach the main
  // process, where they surface as "Unsupported external URL".
  if (!isAllowedExternalUrl(url)) {
    return;
  }

  if (isWeb) {
    const opener = getDesktopHost()?.opener?.openUrl;
    if (typeof opener === "function") {
      await opener(url);
      return;
    }

    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }

  await Linking.openURL(url);
}
