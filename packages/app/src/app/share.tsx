import { Redirect, type Href } from "expo-router";
import { GuestShareScreen, readGuestShareHint } from "@/screens/share/guest-share-screen";

// Guest-mode entry (spec §21 / ADR-0019): the real app served through the Cloudflare tunnel boots
// straight into the shared agent's chat. If there's no share hint (opened outside a share), fall
// back to the normal app.
export default function ShareRoute() {
  const hint = readGuestShareHint();
  if (!hint) {
    return <Redirect href={"/" as Href} />;
  }
  return <GuestShareScreen hint={hint} />;
}
