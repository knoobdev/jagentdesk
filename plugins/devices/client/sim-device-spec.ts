// Device-accurate simulator geometry: which devices have a Touch-ID home button (rectangular
// screen + forehead/chin) vs Face-ID (rounded screen), each generation's real screen corner radius,
// and the exact screen aspect read from the screenshot PNG. Sources: Apple display corner radii
// (ScreenCorners dataset) and the simctl device-type catalog.

export function isTablet(name: string): boolean {
  return /ipad/i.test(name);
}
// Fallback portrait ratio before the first frame arrives.
export function deviceAspect(name: string): number {
  return isTablet(name) ? 0.72 : 0.462;
}

export interface DeviceSpec {
  homeButton: boolean;
  radiusRatio: number; // screen corner radius ÷ screen width (0 = rectangular LCD)
  bezelX: number; // side bezel ÷ screen width
  bezelY: number; // top (= bottom) bezel ÷ screen height
  homeRatio: number; // Touch-ID button diameter ÷ screen width (home-button devices only)
}

// Apple tech-spec enclosure size (mm) + native display resolution (px) and pixel density (ppi),
// first match wins. Active display size = px ÷ ppi × 25.4, so the bezels are the REAL
// (enclosure − display) / 2 of each model, not a guess.
type Phys = readonly [RegExp, number, number, number, number, number];
const PHYS: readonly Phys[] = [
  [/iphone 17 pro max/, 78.0, 163.4, 1320, 2868, 460],
  [/iphone 17 pro/, 71.9, 150.0, 1206, 2622, 460],
  [/iphone air/, 74.7, 156.2, 1260, 2736, 460],
  [/iphone 17\b/, 71.5, 149.6, 1206, 2622, 460],
  [/iphone 16 pro max/, 77.6, 163.0, 1320, 2868, 460],
  [/iphone 16 pro/, 71.5, 149.6, 1206, 2622, 460],
  [/iphone 16e/, 71.5, 146.7, 1170, 2532, 460],
  [/iphone (?:15|16) plus/, 77.8, 160.9, 1290, 2796, 460],
  [/iphone 15 pro max/, 76.7, 159.9, 1290, 2796, 460],
  [/iphone 14 pro max/, 77.6, 160.7, 1290, 2796, 460],
  [/iphone 15 pro/, 70.6, 146.6, 1179, 2556, 460],
  [/iphone 14 pro/, 71.5, 147.5, 1179, 2556, 460],
  [/iphone (?:15|16)\b/, 71.6, 147.6, 1179, 2556, 460],
  [/iphone 1[2-4] mini/, 64.2, 131.5, 1080, 2340, 476],
  [/iphone 14 plus|iphone 1[23] pro max/, 78.1, 160.8, 1284, 2778, 458],
  [/iphone 1[2-4]\b/, 71.5, 146.7, 1170, 2532, 460],
  [/iphone 11 pro max|iphone xs max/, 77.8, 158.0, 1242, 2688, 458],
  [/iphone 11 pro|iphone xs|iphone x(?:\s|$)/, 71.4, 144.0, 1125, 2436, 458],
  [/iphone 11|iphone x[ʀr]/, 75.7, 150.9, 828, 1792, 326],
  [/iphone (?:6s|7|8) plus/, 78.1, 158.4, 1080, 1920, 401],
  [/iphone se \(1st|ipod/, 58.6, 123.8, 640, 1136, 326],
  [/iphone (?:se|6s|7|8)/, 67.3, 138.4, 750, 1334, 326],
  [/ipad pro 13-inch/, 215.5, 281.6, 2064, 2752, 264],
  [/ipad pro 11-inch/, 177.5, 249.7, 1668, 2420, 264],
  [/ipad pro \(12\.9-inch\) \((?:1st|2nd)/, 220.6, 305.7, 2048, 2732, 264],
  [/ipad pro \(12\.9-inch\)|ipad air 13-inch/, 214.9, 280.6, 2048, 2732, 264],
  [/ipad pro \(11-inch\)/, 178.5, 247.6, 1668, 2388, 264],
  [/ipad pro \(10\.5-inch\)|ipad air \(3rd/, 174.1, 250.6, 1668, 2224, 264],
  [/ipad \(10th/, 179.5, 248.6, 1640, 2360, 264],
  [/ipad air 11-inch|ipad air \((?:4th|5th)/, 178.5, 247.6, 1640, 2360, 264],
  [/ipad mini \((?:6th|a17)/, 134.8, 195.4, 1488, 2266, 326],
  [/ipad mini/, 134.8, 203.2, 1536, 2048, 326],
  [/ipad \((?:7th|8th|9th)/, 174.1, 250.6, 1620, 2160, 264],
  [/ipad/, 169.5, 240.0, 1536, 2048, 264], // 9.7" family: iPad 5th/6th, Air 2, Pro 9.7
];

const TOUCH_ID_MM = 10.5; // home-button diameter

function isHomeButton(n: string): boolean {
  if (/ipad/.test(n)) {
    return (
      /ipad \([1-9](?:st|nd|rd|th) generation\)/.test(n) || // base iPad 1st–9th gen
      /^ipad air(?: 2)?$/.test(n) || // original iPad Air / Air 2 (no parens in simctl names)
      /^ipad mini(?: [1-4])?$/.test(n) || // iPad mini … mini 4
      /ipad air \((?:1st|2nd|3rd) generation\)/.test(n) ||
      /ipad mini \((?:1st|2nd|3rd|4th|5th) generation\)/.test(n) ||
      /ipad pro \(9\.7-inch\)/.test(n) ||
      /ipad pro \(10\.5-inch\)/.test(n) ||
      /ipad pro \(12\.9-inch\) \((?:1st|2nd) generation\)/.test(n)
    );
  }
  return /ipod/.test(n) || /iphone (se|8|7|6s?|5s?|5c|4s?)\b/.test(n);
}

// Classify by the device TYPE name (e.g. "iPhone SE (3rd generation)"), never the user's own
// device name. homeButton devices have a RECTANGULAR screen with forehead + chin + Touch-ID;
// Face-ID devices have a rounded screen (Apple's real corner radius) and a thin uniform bezel.
export function deviceSpec(typeName: string): DeviceSpec {
  const n = typeName.toLowerCase();
  const homeButton = isHomeButton(n);
  const phys = PHYS.find(([re]) => re.test(n));
  let bezelX = /ipad/.test(n) ? 0.06 : 0.045;
  let bezelY = homeButton ? 0.17 : bezelX;
  let homeRatio = 0.18;
  if (phys) {
    const [, bw, bh, pw, ph, ppi] = phys;
    const sw = (pw / ppi) * 25.4;
    const sh = (ph / ppi) * 25.4;
    bezelX = (bw - sw) / 2 / sw;
    bezelY = (bh - sh) / 2 / sh;
    homeRatio = TOUCH_ID_MM / sw;
  }
  let radiusRatio = 0;
  if (!homeButton) radiusRatio = /ipad/.test(n) ? ipadRadiusRatio(n) : iphoneRadiusRatio(n);
  return { homeButton, radiusRatio, bezelX, bezelY, homeRatio };
}

// Exact per-generation display corner radius (pt) ÷ logical width (pt), first match wins.
// Values are Apple's real screen corner radii (ScreenCorners dataset). simctl spells XR "Xʀ".
const IPHONE_RADIUS: ReadonlyArray<readonly [RegExp, number, number]> = [
  [/iphone air/, 62, 420],
  [/iphone 16e/, 47.33, 390],
  [/iphone (?:1[6-9]|[2-9]\d) pro max/, 62, 440],
  [/iphone (?:1[6-9]|[2-9]\d) pro/, 62, 402],
  [/iphone (?:1[7-9]|[2-9]\d) plus/, 62, 440],
  [/iphone (?:1[7-9]|[2-9]\d)\b/, 62, 402],
  [/iphone (?:15|16) plus|iphone (?:14|15) pro max/, 55, 430],
  [/iphone (?:15|16)\b|iphone 14 pro/, 55, 393],
  [/iphone 1[2-4] mini/, 44, 375],
  [/iphone 1[2-4] (?:pro max|plus)/, 53.33, 428],
  [/iphone 1[2-4]\b/, 47.33, 390],
  [/iphone x[ʀr](?:\s|$)|iphone 11(?! pro)/, 41.5, 414],
  [/iphone 11 pro max|iphone xs max/, 39, 414],
  [/iphone 11 pro|iphone x/, 39, 375],
];

function iphoneRadiusRatio(n: string): number {
  const hit = IPHONE_RADIUS.find(([re]) => re.test(n));
  return hit ? hit[1] / hit[2] : 55 / 393;
}

function ipadRadiusRatio(n: string): number {
  if (n.includes("mini")) return 21.5 / 744;
  if (n.includes("13-inch") || n.includes("12.9-inch")) return 18 / 1024;
  return 18 / 820; // iPad 10th gen, Air 11-inch/4th/5th, Pro 11-inch
}

// Read the EXACT pixel dimensions straight from the PNG's IHDR (width @ byte 16, height @ 20, after
// the 8-byte signature + IHDR length/type), so the frame matches the real screen aspect of ANY
// device (iPhone SE, mini, Pro Max, every iPad) and `cover` fills with zero crop. Synchronous, so
// no per-frame async work that would jank the grid.
export function pngAspect(dataUri: string): number | null {
  try {
    const comma = dataUri.indexOf(",");
    const head = comma >= 0 ? dataUri.slice(comma + 1, comma + 1 + 44) : dataUri.slice(0, 44);
    const g = globalThis as { atob?: (s: string) => string };
    if (!g.atob) return null;
    const bin = g.atob(head);
    const at = (i: number) => bin.charCodeAt(i);
    const w = (at(16) << 24) | (at(17) << 16) | (at(18) << 8) | at(19);
    const h = (at(20) << 24) | (at(21) << 16) | (at(22) << 8) | at(23);
    return w > 0 && h > 0 ? w / h : null;
  } catch {
    return null;
  }
}
