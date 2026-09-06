// P5-device verification for the agentic browser anti-detect layer, run in a REAL
// Electron process. Exercises the exact production path — browser-stealth
// applyStealthToWebContents → CDP init script (webdriver/navigator/WebGL/canvas) +
// Network.setUserAgentOverride (UA + UA-CH) + Emulation.setTimezoneOverride /
// setLocaleOverride — on a live webContents, which playwright cannot cover because
// it uses Electron's built-in debugger rather than Chromium's launch protocol.
//
// Requires the desktop main to be compiled first:  npm run build:main
// Run:  npx electron scripts/verify-fingerprint-electron.cjs
// Exits 0 when every check passes, 1 otherwise; prints a JSON report.
const { app, BrowserWindow } = require("electron");
const {
  setActiveFingerprintProfile,
  applyStealthToWebContents,
} = require("../dist/features/browser-stealth.js");

process.on("unhandledRejection", (error) => {
  console.error("verify-fingerprint-electron:", error);
  app.exit(1);
});

app.whenReady().then(async () => {
  const { generateFingerprintProfile } =
    await import("@jagentdesk/protocol/browser-automation/fingerprint-profile");
  const profile = generateFingerprintProfile({
    id: "p5",
    os: "macos",
    timezone: "Europe/Berlin",
    locale: "de-DE",
    languages: ["de-DE", "de"],
    nowMs: Date.now(),
  });
  setActiveFingerprintProfile(profile);

  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 768,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  const contents = win.webContents;
  // Spin up the renderer first (mirrors a webview that already has a guest) so the
  // CDP commands have a target; the init script then applies on the next navigation.
  await contents.loadURL("about:blank");
  await applyStealthToWebContents(contents);
  await contents.loadURL("data:text/html,<html><body>p5</body></html>");

  const got = await contents.executeJavaScript(`(() => {
    let vendor = null, renderer = null;
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      const e = gl && gl.getExtension('WEBGL_debug_renderer_info');
      if (e) { vendor = gl.getParameter(e.UNMASKED_VENDOR_WEBGL); renderer = gl.getParameter(e.UNMASKED_RENDERER_WEBGL); }
    } catch (err) {}
    let canvasStable = false, canvasNative = false;
    try {
      const draw = () => { const c = document.createElement('canvas'); c.width=200; c.height=50;
        const x = c.getContext('2d'); x.fillStyle='#f60'; x.fillRect(0,0,200,50); x.fillStyle='#069'; x.fillText('t',2,2); return c.toDataURL(); };
      canvasStable = draw() === draw();
      canvasNative = HTMLCanvasElement.prototype.toDataURL.toString().includes('[native code]');
    } catch (err) {}
    return {
      webdriver: navigator.webdriver, platform: navigator.platform, ua: navigator.userAgent,
      langs: navigator.languages.join(','), tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      hw: navigator.hardwareConcurrency, dm: navigator.deviceMemory, vendor, renderer, canvasStable, canvasNative,
    };
  })()`);

  const checks = {
    webdriverHidden: got.webdriver === undefined,
    platform: got.platform === "MacIntel",
    uaOverride: got.ua === profile.userAgent,
    timezoneOverride: got.tz === "Europe/Berlin",
    localeLangs: got.langs === "de-DE,de",
    hardware: got.hw === profile.hardwareConcurrency,
    webgl: got.vendor === profile.webglVendor && got.renderer === profile.webglRenderer,
    canvasStable: got.canvasStable === true,
    canvasNative: got.canvasNative === true,
  };
  const passed = Object.values(checks).every(Boolean);
  console.log(JSON.stringify({ got, checks, passed }, null, 2));
  app.exit(passed ? 0 : 1);
});
