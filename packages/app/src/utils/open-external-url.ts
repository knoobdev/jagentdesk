import * as Linking from "expo-linking";
import { getDesktopHost } from "@/desktop/host";
import { isWeb } from "@/constants/platform";

import { isHttpUrl } from "./http-url";

export async function openExternalUrl(url: string): Promise<void> {
  // Validate before handing the URL to Electron's opener IPC. Custom app
  // schemes and placeholders from old screens must never reach the main
  // process, where they surface as "Unsupported external URL".
  if (!isHttpUrl(url)) {
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
