import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Image,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  Pressable,
  Text,
  View,
} from "react-native";
import { Play, Smartphone, Tablet } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import { Skeleton } from "@/components/ui/skeleton";
import { deviceAspect, deviceSpec, isTablet, pngAspect } from "@/screens/sim-device-spec";

export const TILE_POLL_MS = 2000;
export const DRIVE_POLL_MS = 900;
// Long-edge caps: ~2× the drawn size, so frames stay crisp on retina without shipping full-res.
export const TILE_MAX_DIM = 480;
export const DRIVE_MAX_DIM = 1600;
const FRAME_BORDER = 1.5; // device outline

const screenMuted = () => ({ color: "#9ca3af" }); // legible on the black device screen
const ThemedSmartphone = withUnistyles(Smartphone);
const ThemedTablet = withUnistyles(Tablet);
const ThemedPlay = withUnistyles(Play);
const ThemedSpinner = withUnistyles(ActivityIndicator);

export interface Screenshot {
  source: { uri: string };
  aspect: number | null; // width / height of the frame
}

// Poll a booted device's screen as a JPEG capped at `maxDim` px (a full-res PNG is up to ~5 MB —
// a fleet of those floods the socket). The next frame is requested only after the previous one
// lands, so a slow capture can't pile requests up. Keyed on stable primitives so the fleet
// snapshot re-arriving (a NEW device object each time) can't reset the image mid-load.
export function useScreenshot(
  client: DaemonClient | null,
  udid: string | null,
  isBooted: boolean,
  pollMs: number,
  maxDim: number,
): Screenshot | null {
  const [shot, setShot] = useState<Screenshot | null>(null);
  useEffect(() => {
    if (!client || !udid || !isBooted) {
      setShot(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const grab = async () => {
      try {
        const res = await client.simulatorScreenshot({ udid, format: "jpeg", maxDim });
        // Older daemons ignore format/maxDim and answer with a full PNG in `pngBase64`.
        const data = res.imageBase64 || res.pngBase64;
        if (!cancelled && data) {
          const uri = `data:${res.mimeType ?? "image/png"};base64,${data}`;
          const aspect = res.width && res.height ? res.width / res.height : pngAspect(uri);
          setShot({ source: { uri }, aspect });
        }
      } catch {
        /* transient — next tick retries */
      }
      if (!cancelled) timer = setTimeout(() => void grab(), pollMs);
    };
    void grab();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [client, udid, isBooted, pollMs, maxDim]);
  return shot;
}

// Waiting state inside the device screen: a breathing skeleton behind a spinner + label, so a
// cold boot or the first frame reads as "working", never as a dead black rectangle.
function ScreenWaiting({ label }: { label: string }) {
  return (
    <View style={styles.phoneFill}>
      <Skeleton width="100%" height="100%" radius={0} style={styles.waitingSkeleton} />
      <View style={styles.waitingOverlay}>
        <ThemedSpinner uniProps={screenMuted} />
        <Text style={styles.phoneHint}>{label}</Text>
      </View>
    </View>
  );
}

// A device-accurate mockup that fits within (maxW × maxH): the SCREEN is sized first at the exact
// frame aspect, then the body grows around it by that model's real bezels — so the frame fills the
// screen with zero crop. Booted → live frame; otherwise a waiting state / Boot button.
export function PhoneScreen({
  name,
  typeName,
  booted,
  booting,
  source,
  shotAspect,
  maxW,
  maxH,
  onBoot,
  onLayout,
  onTap,
}: {
  name: string;
  typeName: string; // Apple device type, e.g. "iPhone SE (3rd generation)" — drives the geometry
  booted: boolean;
  booting?: boolean;
  source: { uri: string } | null;
  shotAspect: number | null; // real frame aspect, once the first frame arrives
  maxW: number;
  maxH: number;
  onBoot?: () => void;
  onLayout?: (e: LayoutChangeEvent) => void;
  onTap?: (e: GestureResponderEvent) => void;
}) {
  const tablet = isTablet(typeName);
  const spec = deviceSpec(typeName);
  const aspect = shotAspect ?? deviceAspect(typeName); // screen w/h

  const dyn = useMemo(() => {
    const outline = FRAME_BORDER * 2;
    if (spec.homeButton) {
      // Rectangular LCD + forehead/chin (Touch-ID device).
      const sw = Math.min(
        (maxW - outline) / (1 + 2 * spec.bezelX),
        ((maxH - outline) / (1 + 2 * spec.bezelY)) * aspect,
      );
      const sh = sw / aspect;
      const side = sw * spec.bezelX;
      const band = sh * spec.bezelY;
      const bodyW = sw + 2 * side + outline;
      const home = sw * spec.homeRatio;
      return {
        homeButton: true as const,
        body: {
          width: bodyW,
          height: sh + 2 * band + outline,
          borderRadius: bodyW * (tablet ? 0.07 : 0.14),
        },
        band: { height: band },
        screen: { width: sw, height: sh },
        home: { width: home, height: home, borderRadius: home / 2 },
      };
    }
    // Face-ID: rounded screen at the device's real radius, uniform bezel.
    const sw = Math.min(
      (maxW - outline) / (1 + 2 * spec.bezelX),
      (maxH - outline) / (1 / aspect + 2 * spec.bezelX),
    );
    const sh = sw / aspect;
    const bezel = sw * spec.bezelX;
    const sr = sw * spec.radiusRatio;
    const w = sw + 2 * bezel + outline;
    const h = sh + 2 * bezel + outline;
    return {
      homeButton: false as const,
      wrap: { width: w, height: h },
      frame: { width: w, height: h, borderRadius: sr + bezel + FRAME_BORDER, padding: bezel },
      screen: { width: sw, height: sh, borderRadius: sr },
      b1: { top: h * 0.2, height: h * 0.05 },
      b2: { top: h * 0.29, height: h * 0.09 },
      b3: { top: h * 0.41, height: h * 0.09 },
      bp: { top: h * 0.3, height: h * 0.14 },
    };
  }, [spec, aspect, maxW, maxH, tablet]);

  let inner;
  if (booted && source) {
    inner = (
      <Pressable style={styles.phoneFill} onPress={onTap} onLayout={onLayout} disabled={!onTap}>
        <Image source={source} style={styles.phoneFill} resizeMode="cover" />
      </Pressable>
    );
  } else if (booting) {
    inner = <ScreenWaiting label="Booting…" />;
  } else if (booted) {
    inner = <ScreenWaiting label="Connecting…" />;
  } else if (onBoot) {
    inner = (
      <Pressable style={styles.phoneCenter} onPress={onBoot} accessibilityLabel={`Boot ${name}`}>
        <View style={styles.bootPill}>
          <ThemedPlay size={12} uniProps={screenMuted} />
          <Text style={styles.bootPillText}>Boot</Text>
        </View>
      </Pressable>
    );
  } else {
    const Icon = tablet ? ThemedTablet : ThemedSmartphone;
    inner = (
      <View style={styles.phoneCenter}>
        <Icon size={26} uniProps={screenMuted} />
      </View>
    );
  }
  if (dyn.homeButton) {
    return (
      <View style={[styles.hbBody, dyn.body]}>
        <View style={dyn.band} />
        <View style={[styles.screenBox, dyn.screen]}>{inner}</View>
        <View style={[styles.hbChin, dyn.band]}>
          <View style={[styles.homeBtn, dyn.home]} />
        </View>
      </View>
    );
  }
  return (
    <View style={dyn.wrap}>
      {!tablet ? (
        <>
          <View style={[styles.sideBtn, styles.sideLeft, dyn.b1]} />
          <View style={[styles.sideBtn, styles.sideLeft, dyn.b2]} />
          <View style={[styles.sideBtn, styles.sideLeft, dyn.b3]} />
          <View style={[styles.sideBtn, styles.sideRight, dyn.bp]} />
        </>
      ) : null}
      <View style={[styles.phoneFrame, dyn.frame]}>
        <View style={[styles.screenBox, dyn.screen]}>{inner}</View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Realistic device: near-black bezel with a faint titanium ring, wrapping the screen the
  // screenshot fills edge to edge.
  phoneFrame: {
    borderWidth: FRAME_BORDER,
    borderColor: "#48484a",
    backgroundColor: "#000",
    overflow: "hidden",
  },
  sideBtn: { position: "absolute", width: 3, borderRadius: 2, backgroundColor: "#3a3a3c" },
  sideLeft: { left: -2 },
  sideRight: { right: -2 },
  // Touch-ID device body: black slab with forehead + chin around a rectangular screen.
  hbBody: {
    backgroundColor: "#000",
    borderWidth: FRAME_BORDER,
    borderColor: "#48484a",
    overflow: "hidden",
    alignItems: "center",
  },
  // Fixed-size screen (explicit width/height from the geometry) — never flex, which collapses it
  // to 0 inside an auto-height body.
  screenBox: {
    backgroundColor: "#000",
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  hbChin: { width: "100%", alignItems: "center", justifyContent: "center" },
  homeBtn: { borderWidth: 1.5, borderColor: "#5a5a5c", backgroundColor: "#0a0a0a" },
  phoneFill: { width: "100%", height: "100%" },
  phoneCenter: { flex: 1, alignItems: "center", justifyContent: "center", gap: theme.spacing[2] },
  waitingSkeleton: { position: "absolute", backgroundColor: "#1c1c1e" },
  waitingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
  },
  phoneHint: { color: "#9ca3af", fontSize: theme.fontSize.xs },
  bootPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.10)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
  },
  bootPillText: { color: "#e5e7eb", fontSize: theme.fontSize.xs },
}));
