# Agentic browser — tự custom toàn bộ + anti-detect (fingerprint profiles)

Reported 2026-09-06. Mở rộng agentic browser để **agent tự custom toàn bộ browser**:
tạo/dùng lại **fingerprint profile** (chống nhận diện bot), proxy, extension, init-script,
và một escape-hatch CDP thô. Có **danh sách profile** cho người dùng chọn (hoặc agent hỏi
người dùng chọn profile nào).

## Sự thật kỹ thuật (đọc trước khi làm)

- Agentic browser **KHÔNG dùng Playwright**. Nó là Electron `<webview>` guest, lái bằng
  `webContents.debugger` (CDP) + `executeJavaScript`. Seam anti-detect ĐÃ có:
  `packages/desktop/src/features/browser-stealth.ts` dùng CDP
  `Page.addScriptToEvaluateOnNewDocument` (inject trước script trang). Authority: ADR-0011.
- **"Fake IP" bắt buộc route qua proxy thật** — không có cách giả IP thuần trong browser.
  UI/tool phải nói rõ điều này, không hứa hão.
- **Nhất quán là tất cả**: fingerprint mâu thuẫn (UA nói Windows nhưng WebGL nói Apple) bị
  cờ NẶNG hơn không spoof. Vì vậy dùng **profile nhất quán sinh từ template thiết bị thật**,
  không phải 40 toggle rời rạc. Hoặc spoof cả một danh tính, hoặc không spoof gì.
- Canvas/audio noise phải **deterministic theo seed của profile** (ổn định trong 1 phiên,
  khác giữa các profile) và **mask `toString()` về native-code**, nếu không lộ ngay.
- CDP `Runtime.enable` leak: V8 M137+ đã vá ở engine; Electron hiện tại thường đủ mới. Không
  làm gì thêm ở v1, ghi nhận rủi ro.

## Kiến trúc (layered)

Nguồn sự thật duy nhất cho một danh tính = một `BrowserFingerprintProfile`. Mọi surface
(UA, UA-CH, WebGL, timezone, screen, canvas seed) dẫn xuất từ cùng template nên không mâu thuẫn.

| Layer | Nơi | Nội dung |
|---|---|---|
| Model + generator | `packages/protocol/src/browser-automation/fingerprint-profile.ts` | Schema profile + generator thuật toán (KHÔNG gọi LLM) sinh profile nhất quán từ template thiết bị thật |
| Persistence | `persisted-config.ts` `browserTools.{profiles, activeProfileId}` (đã `.passthrough()`) | Lưu profiles + profile đang active |
| RPC | protocol messages + `daemon-client.ts` + `session.ts` | get / save / delete / select profile |
| Agent tools | `browser-tools/tools.ts` (+ command mới) | `browser_profile_list`, `browser_profile_create`, `browser_profile_use`, `browser_cdp` (CDP thô), `browser_add_init_script` |
| Apply (desktop) | `browser-stealth.ts` (tổng quát hoá) + `main.ts` will/did-attach | Build init-script từ profile; UA/timezone/locale/deviceMetrics qua CDP; proxy qua `session.setProxy`; extension qua `session.loadExtension`; WebRTC policy |
| UI | `screens/settings/browser-*` + browser cockpit | List profile, tạo, chọn, xoá; picker "dùng profile nào" |

## Các mặt fingerprint phải điều khiển (init-script sinh từ profile)

navigator.webdriver · window.chrome · languages/plugins · permissions.query ·
WebGL vendor/renderer (khớp OS) · **canvas** (toDataURL/toBlob/getImageData + mask toString) ·
**audio** (getChannelData) · hardwareConcurrency/deviceMemory · screen/devicePixelRatio ·
**UA-CH** (Sec-CH-UA*, userAgentData) qua CDP `Network.setUserAgentOverride` (userAgentMetadata) ·
**timezone** qua `Emulation.setTimezoneOverride` · **locale** qua `Emulation.setLocaleOverride` ·
deviceMetrics qua `Emulation.setDeviceMetricsOverride`. Dùng `Emulation.*` ở ranh giới engine
thay vì monkey-patch JS ở đâu có thể (ít bị phát hiện hơn).

## Phases

- [ ] **P1 — Model + generator + persistence + RPC (protocol/server/client).** Fully typecheck.
      Schema `BrowserFingerprintProfile`, generator template (Windows/macOS/Linux Chrome), config
      keys, 4 RPC (get/save/delete/select) + handler + operation-permission.
- [ ] **P2 — Agent tools.** `browser_profile_list/create/use` + `browser_cdp` escape-hatch +
      `browser_add_init_script`. Đăng ký sau `browserToolsEnabled`.
- [ ] **P3 — Desktop apply.** Tổng quát hoá `browser-stealth.ts` từ cờ global → theo profile
      active: build init-script (canvas/audio/UA-CH/WebGL/timezone/screen), UA/timezone/locale/
      deviceMetrics qua CDP, proxy `session.setProxy`, extension `session.loadExtension`, WebRTC.
- [ ] **P4 — UI.** List/tạo/chọn/xoá profile trong settings; picker cho agent hỏi người dùng.
- [ ] **P5 — Verify.** Chạy desktop thật, mở CreepJS/BrowserScan, kiểm mỗi surface nhất quán;
      test proxy đổi IP thật; test load 1 extension.

## Ràng buộc / ghi chú

- Extension chỉ nạp được với **persistent context** (đã có partition `persist:jagentdesk-browser`)
  và **new headless**/non-headless. Ghi log nếu bỏ qua.
- v1 dùng chung 1 storage partition; **1 profile = 1 partition** (cookies theo danh tính) là
  nâng cấp sau — ghi nhận, chưa làm.
- Anti-detect gate sau opt-in của người dùng (browserTools.enabled + chọn profile). Không ship
  như công cụ tấn công. Tôn trọng ToS/robots ở policy layer.
- Không đoán Paseo; đây là tính năng JAgentDesk mới, cần bổ sung ADR-0011 cho scope mở rộng.

## Trạng thái (2026-09-06)
- [x] **P1 DONE** — `protocol/browser-automation/fingerprint-profile.ts` (schema + generator
      template Windows/macOS/Linux Chrome, coherent) + config keys `browserTools.{profiles,
      activeProfileId}` ở protocol `messages.ts` và `persisted-config.ts`. 6 test xanh
      (coherence UA/UA-CH/WebGL, seed deterministic, WebRTC force-proxy khi có proxy).
      Quản lý qua daemon-config get/patch có sẵn — KHÔNG cần RPC mới.
- [x] **P3-core DONE** — `desktop/features/browser-fingerprint-script.ts`
      `buildFingerprintInitScript(profile)`: webdriver/chrome/languages/plugins/permissions/
      platform/hardware/screen + WebGL theo profile + **canvas noise** (getImageData/toDataURL/
      toBlob, seeded ±1 LSB) + **audio noise** (getChannelData) + mask `toString()` native-code.
      4 test xanh. Là hàm thuần, chưa gắn caller.
- [x] **P2 DONE** — agent tools trong `jagentdesk-tools.ts`: `browser_profile_list`,
      `browser_profile_create` (name/os/timezone/locale/languages/proxy/webrtcPolicy/extensions/
      initScripts/stealthEnabled/activate), `browser_profile_use`. Gate sau `browserToolsEnabled`.
      Accessor `browserFingerprintProfiles` (list/activeId/save/select) backed by `daemonConfigStore`
      (bootstrap). Patch → broadcast status:daemon_config_changed → sync re-apply.
- [x] **P3-wiring DONE** — `browser-stealth.ts` profile-first: init-script fingerprint + custom
      initScripts + CDP `Network.setUserAgentOverride` (UA+UA-CH), `Emulation.setTimezoneOverride`/
      `setLocaleOverride`; WebRTC policy per-webContents (`setWebRTCIPHandlingPolicy` + disable-RTC
      script). `browser-network.ts`: proxy `session.setProxy` + `loadExtension` + proxy-auth
      `app.on('login')`. IPC `jagentdesk:browser:set-fingerprint-profile` (main) + preload +
      host type. Renderer đọc active profile từ daemon config (`fingerprint-profile-sync.ts`,
      mount cạnh browser-automation handler trong `host-runtime.ts`) → push tới main.
      KHÔNG force device-metrics (tránh resize guest); screen.* spoof trong init-script.
- [x] **P4 DONE** — `browser-fingerprint-profiles-card.tsx` trong Host settings (dưới Browser tools):
      list + active marker + "Real identity (null)" + tạo theo OS + Delete. Helper thuần
      `browser-fingerprint-config.ts` (+ test).
- [x] **P5 (core) DONE** — verify engine anti-detect trong **Chromium THẬT** qua playwright
      (`browser-fingerprint-script.e2e.test.ts`, opt-in `PW_E2E=1`; cùng CDP primitive
      addScriptToEvaluateOnNewDocument product dùng). 6/6 xanh: webdriver ẩn, navigator
      (platform/hardware/deviceMemory/UA/languages), timezone/locale nhất quán, WebGL vendor/
      renderer, screen metrics, canvas ổn định + native-mask + **khác nhau theo profile seed**.
      **Bug P5 bắt được + đã fix:** noisify gọi getImageData đã-patch → XOR 2 lần cùng seed triệt
      tiêu → canvas không đổi; sửa thành offscreen-clone noise 1 lần (không mutate canvas gốc).
- [x] **P5 (device engine) DONE** — verify đúng path Electron THẬT qua
      `packages/desktop/scripts/verify-fingerprint-electron.cjs` (`npm run build:main` →
      `npx electron scripts/verify-fingerprint-electron.cjs`). Gọi thẳng
      `applyStealthToWebContents` trên webContents thật; **passed: true** cho: webdriver ẩn,
      platform MacIntel, **UA + UA-CH qua CDP `Network.setUserAgentOverride`**, **timezone qua
      `Emulation.setTimezoneOverride`** (Intl→Europe/Berlin), locale de-DE, hardware, WebGL
      vendor/renderer, canvas ổn định + native-mask. Đây là các phần playwright KHÔNG chạm
      được (Electron dùng debugger built-in, không phải launch-protocol Chromium).
      Lưu ý: init-script áp dụng từ navigation KẾ TIẾP sau applyStealth (cần renderer sẵn) —
      khớp comment product "Runs on the next navigation".
- [ ] **P5 (external) TODO** — chỉ 3 mục còn lại cần mạng ngoài/artefact: proxy đổi IP thật
      (cần proxy server), WebRTC không rò (cần STUN + IP ngoài), `session.loadExtension` (cần
      thư mục extension). Chạy tay với whatismyip/CreepJS khi có proxy + extension thật.
- [ ] **Nâng cấp sau** — `browser_cdp` (CDP thô per-command, cần thêm command vào broker + desktop
      service) + `browser_profile_update`. Hiện agent custom qua `initScripts`/`extensions` của profile.

Tests: protocol 6 (generator coherence/seed/webrtc), desktop 4 (init-script compiler), app 4
(config helper). 4 package typecheck 0.

Cùng đợt: Task 1 (row-select cross-page + click-outside clear) + Task 2 (formatTokenCount "1m"
collapse) đã xong.
