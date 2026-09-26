# Plan — Workbench (Burp Suite CE parity + SimFleet capture + Frida unpinning + agent control)

Branch: `feat/burp-workbench`. Tài liệu kèm theo: `burp-workbench-ui-reference.md` (UI Burp CE),
`burp-workbench-capture-design.md` (bắt traffic + Frida).

Bối cảnh & phạm vi hợp lệ: workbench kiểm thử bảo mật app cho **iOS Simulator chạy trên máy host
của chính người dùng** (SimFleet). Tương đương cặp Burp + objection/Frida trong pentest được phép.

## Kiến trúc (theo đúng khuôn SimFleet — nguồn: agent map codebase)

Mirror end-to-end như SimFleet/Docker. **Tên nội bộ:** `proxy` (route/RPC), nhãn UI "Workbench".

### protocol (`packages/protocol/src/proxy/rpc-schemas.ts`)
- helpers `req()/resp()/push()` như `simulator/rpc-schemas.ts`.
- RPC (req/resp): captureStart, captureStop, sessionsList, historyQuery, transactionGet,
  repeaterSend, decoder, comparerAdd, intruderRun, scopeGet/scopeSet, fridaScriptsList,
  fridaScriptLoad, fridaApply, caExport.
- push: `proxy/transaction` (1 giao dịch HTTP mới), `proxy/session` (đổi trạng thái phiên),
  `proxy/event` (log).
- Gom vào `ProxyRequestSchemas / ProxyResponseSchemas / ProxyPushSchemas`, spread vào
  `messages.ts` (`SessionInboundMessageSchema` ~:3977, `SessionOutboundMessageSchema` ~:7726).

### server (`packages/server/src/server/proxy/`)
- `ca.ts` — sinh/cache CA (node-forge, pure JS), ký cert theo SNI, export CA PEM.
- `mitm-proxy.ts` — forward proxy MITM trên `node:http`/`net`/`tls`: CONNECT → TLS terminate
  (cert ký theo host) → ghi request/response → forward upstream. Cấp phát cổng động
  (theo `workspace-service-port-allocator.ts`).
- `capture-store.ts` — lưu giao dịch (in-memory ring + query theo session/host/method/status/
  contains/limit), gắn `sessionId, udid, bundleId, ts_ms`.
- `capture-session.ts` — 1 phiên = listener + (P4) attach Frida vào app trên 1 udid.
- `frida-control.ts` (P4) — shell ra CLI `frida`/`frida-ps` (đã có trên host), nạp script.
- `frida-scripts/` — bộ script unpinning tuyển chọn (kèm nguồn+license) + loader codeshare.
- `proxy-streams.ts` — producer đẩy push (giống docker-streams).
- Wire `session.ts`: import (~:181), field (~:836), dispatcher-chain (~:2249),
  `dispatchProxyMessage()` (mẫu `dispatchDockerMessage` :3195 / simulator :3541).

### client (`packages/client/src/daemon-client.ts`)
- 1 method/RPC qua `sendCorrelatedSessionRequest`; `onProxyTransaction/onProxySession` +
  `proxySubscribe/proxyUnsubscribe` (mẫu `simulatorSubscribe` :7403, `onSimulatorSnapshot` :7419).

### app (`packages/app/src`)
- `screens/proxy-screen.tsx` — khung Workbench: hàng tab Dashboard/Target/Proxy/Intruder/
  Repeater/Sequencer/Decoder/Comparer/Logger + Captures. Style giống Burp (accent `#ff6633`).
- Component con: `components/proxy/http-history.tsx`, `message-editor.tsx` (Pretty/Raw/Hex +
  Inspector), `site-map.tsx`, `repeater.tsx`, `intruder.tsx`, `decoder.tsx`, `comparer.tsx`,
  `sequencer.tsx`, `captures.tsx`, `scope.tsx`.
- Route: `app/h/[serverId]/proxy.tsx` + `buildProxyRoute` (`utils/host-routes.ts:493`).
- Nav: `components/sidebar/use-app-nav.ts` (icon + `xxxRoute` + `navItem`).
- Dock chat: `PROXY_AGENT_LABEL` trong `utils/dock-agents.ts`, `components/proxy-chat-dock.tsx`,
  `stores/proxy-chat-store.ts`, `components/proxy-ask-agent.ts` (system prompt liệt kê tool).

### agent MCP (`packages/server/src/server/agent/tools/jagentdesk-tools.ts`)
- `registerProxyTools(...)` gọi trong `createJAgentDeskToolCatalog` (~:3707): `proxy_capture_start/
  stop`, `proxy_sessions_list`, `proxy_history_query`, `proxy_request_get`, `proxy_repeater_send`,
  `proxy_intruder_run`, `proxy_decoder`, `proxy_frida_scripts_list/load/apply`. Ghi (mutate)
  dùng `requestHostToolPermission`.

## Phụ thuộc thêm
- `node-forge` (server) — pure JS, an toàn packaging. CA/cert.
- Frida: shell ra CLI (không dùng native binding) — tránh lỗi native-module packaging.
- Bump version mọi package khi cắt release (memory `release-must-bump-version`).

## Giai đoạn (mỗi phase verify: typecheck + test + chạy thật rồi mới sang phase sau)
- **P1 (nền):** node-forge + CA + mitm-proxy + capture-store + protocol(captureStart/stop,
  sessionsList,historyQuery,transactionGet,transaction push) + session wiring + client +
  màn Workbench khung + Proxy/HTTP history + message editor + Captures. Chưa Frida (dùng system/
  manual proxy để test bắt HTTP). ✅ khi bắt được request thật qua listener.
- **P2:** Target/Site map/Scope + Repeater + Decoder + Comparer.
- **P3:** Intruder (giới hạn CE) + Sequencer + Logger + WebSockets history + Intercept (giữ/sửa/
  forward/drop).
- **P4:** Frida unpinning + tích hợp SimFleet (cài CA vào sim `simctl keychain add-root-cert`,
  attach app, mỗi phiên 1 cổng → tự phân biệt sim) + registry script + loader codeshare (duyệt
  trước khi chạy).
- **P5:** MCP tools cho agent + dock chat + proxy-ask-agent + doc/README + release.

## Checklist verify BẮT BUỘC cho mọi màn/panel (yêu cầu người dùng)
Mỗi khi làm xong một màn/panel, luôn kiểm tra (và chụp lại):
1. **Đóng/thu gọn được:** mọi panel phụ (message editor, detail, inspector, side panel…) phải
   đóng/thu gọn được và trả không gian lại cho phần chính.
2. **Cuộn được:** mọi vùng nội dung dài phải cuộn đúng (cả web lẫn mobile), không bị cắt/khoá.
3. **Context menu chuột phải** hoạt động ở bảng/không gian tương ứng (mobile = long-press).
4. Chụp màn gửi người dùng xem.

## Quyết định chốt (ghi để khỏi mở lại)
1. Nhãn UI "Workbench"; không dùng chữ "Burp"/"paseo" trong source theo dõi.
2. Phân biệt sim: mỗi phiên 1 cổng proxy + Frida ép app đi đúng cổng (P4). Trước P4 test bằng
   system proxy 1 sim.
3. Frida codeshare: bộ tuyển chọn đóng gói + loader-theo-slug có bước duyệt; không tải-chạy mù.
4. Intruder giữ giới hạn tốc độ/thời gian như CE.
5. Proxy MITM tự dựng trên node core + node-forge; không thêm native dep; Frida qua CLI.

## Trạng thái
- [x] Nghiên cứu UI Burp CE → `burp-workbench-ui-reference.md`
- [x] Thiết kế capture + Frida → `burp-workbench-capture-design.md`
- [x] Map codebase (điểm nối RPC/stream/MCP/screen)
- [x] **P1 (nền) — XONG, verify chạy thật.**
  - protocol `proxy/rpc-schemas.ts` + spread vào `messages.ts` + `operation-permissions.ts`.
  - server: `proxy/ca.ts` (node-forge CA), `mitm-proxy.ts` (HTTP + CONNECT/TLS terminate),
    `capture-store.ts`, `proxy-service.ts`; nối `session.ts` (import/field/chain/dispatch/dispose).
  - client: `proxyCaptureStart/Stop/SessionsList/HistoryQuery/TransactionGet/CaExport/Subscribe`
    + `onProxyTransaction/onProxySession`.
  - app: `screens/proxy-screen.tsx` (shell tab kiểu Burp) + `components/proxy/` (captures-panel,
    http-history, message-editor, base64 util) + route `/h/[serverId]/proxy` + nav "Workbench" (WB).
  - Verify: unit test `mitm-proxy.test.ts` (HTTP+HTTPS qua CA) 2/2 pass; E2E trong app thật:
    Start capture → 3 request thật đi qua listener `127.0.0.1:<port>` → hiện ở HTTP history +
    message editor (Pretty/Raw/Hex), CA export + hướng dẫn `simctl keychain add-root-cert`.
  - Phụ thuộc thêm: `node-forge` (+types) ở `packages/server`.
- [ ] **P1.5 — Message editor & context menu polish (yêu cầu người dùng):**
  - **Đóng/thu gọn khung request/response** (đã thêm nút ✕ đóng; TODO: divider kéo được để chỉnh
    tỉ lệ history/editor + nút thu gọn thay vì đóng hẳn).
  - **Cuộn đúng** trong request/response trên web (đã thêm minHeight:0; kiểm tra body dài cuộn mượt).
  - Làm đẹp bên trong editor cho giống Burp: **số dòng (gutter)**, **tô màu cú pháp** (JSON/HTML/
    header), thanh **search trong editor**, toggle **word-wrap**, panel **Inspector** (query/body
    params, cookies, headers dạng bảng sửa được), header dạng bảng key/value thay vì text thô.
  - **Context menu chuột phải (bắt buộc — giống Burp):** đã có khung (Copy URL, Copy as cURL chạy;
    Send to Repeater/Decoder/Comparer/Add to scope đang disabled "soon"). Khi P2/P3 có tool thì bật:
    Send to Repeater/Intruder/Sequencer/Decoder/Comparer, Add to scope, Show response in browser,
    Highlight (submenu màu), Add comment, Copy as curl/URL, Delete item. Menu cũng phải có ở
    **site map** và trong **message editor** (bôi đen → Send to…). Mobile = long-press.
- [~] **P2 — đang làm:**
  - [x] **Repeater** — RPC `proxy/repeater/send` (server `http-exec.ts`), UI `repeater-panel.tsx`
    (target scheme/host/port, raw request editor, response Pretty/Raw/Hex), "Send to Repeater" từ
    context menu history. Verify: gửi thật tới origin → 200 + JSON.
  - [x] **Decoder** — `decoder-panel.tsx` (URL/HTML/Base64/ASCII hex/Hex/Octal/Binary + SHA-256
    thật; Gzip/MD5/SHA-1 báo "unavailable" chứ không bịa; Smart decode).
  - [x] **Comparer** — `comparer-panel.tsx` (Add item, Compare Words/Bytes, LCS diff).
  - [x] Nút **Send/Start capture** đổi sang cam Burp (`wb-button.tsx`) theo phản hồi người dùng.
  - [x] **Target / Site map / Scope** — `target-panel.tsx` (cây host từ traffic, bảng phải) +
    `scope-editor.tsx` (RPC `proxy/scope/get|set`, luật include/exclude lưu trên daemon).
- [x] **P3 phần lớn:**
  - [x] **Intruder** (Sniper, CE throttle+cap) — RPC `proxy/intruder/run`, `intruder-panel.tsx`.
    Verify: payload `admin`→403 giữa các 200. "Send to Intruder" từ menu.
  - [x] **Sequencer** — `sequencer-panel.tsx` (manual load, Shannon entropy/bit-per-token + biểu đồ).
  - [x] **Logger** — bảng gộp mọi phiên (screen giữ `allRows`).
  - [ ] Intercept (giữ/sửa/forward/drop) + WebSockets history — CÒN.
- [x] **P5 backend — MCP agent tools:** `registerProxyTools` (proxy_capture_start/stop,
  sessions_list, history_query, request_get, repeater_send, intruder_run, ca_export) trên MCP
  `jagentdesk`. **ProxyService dùng chung toàn daemon** (`getSharedProxyService`) → agent và UI
  thấy cùng capture; mỗi session mang `udid/bundleId` nên agent tự biết đang bắt sim nào. Session
  teardown chỉ gỡ subscriber, capture vẫn sống. Verify: 5/5 test (mitm HTTP/HTTPS + capture +
  repeater + intruder).
  - [ ] Dock chat riêng cho Workbench + system prompt liệt kê tool (polish, CÒN).
- [x] **P3 nốt:** Intercept (`intercept-panel.tsx`, RPC set/decide + held push, MITM hold hook) —
  verify: giữ POST→Forward→client nhận 200. WebSockets history (`ws-tap.ts` parser + tap trong
  tunnel, `ws-history.tsx`) — verify: bắt frame "ping-from-test" thật + 4 unit test WS.
- [~] **P4 — Frida + SimFleet:**
  - [x] `frida-control.ts`: `fridaAvailability` (frida + phát hiện pipx/pip3 để auto-install),
    `installFrida` (auto-cài có hướng dẫn kiểu Forge), `launchAndUnpin` (simctl launch → lấy pid →
    `frida -p pid -l generic-unpin.js`). Script `frida-scripts/generic-unpin.js` **app-agnostic**
    (BoringSSL custom_verify + SecTrust + TrustKit + AFNetworking) — gỡ pin cho BẤT KỲ app chạy
    trên sim, không cần cấu hình per-app.
  - [x] Capture mode "frida": cài CA vào sim (`simctl keychain add-root-cert`) → mở app → unpin nếu
    có Frida. **Không có Frida KHÔNG lỗi cứng**: vẫn cài CA + mở app + bắt (app không pin vẫn thấy),
    kèm ghi chú + nút cài. UI: FridaCard trong Captures (status + "Install Frida"); RPC
    `proxy/frida/status|install`; agent tool `proxy_frida_available|install|unpin`, `proxy_ca_install_sim`.
  - [x] **Cài app hàng loạt + IPA** cho SimFleet: `installAppSmart` (giải nén .ipa → Payload/*.app),
    `installOnMany` (nhiều udid, gộp kết quả); agent tool `sim_install_batch`. Verify: 2 unit test
    (giải nén ipa + gộp lỗi per-udid).
  - [ ] CÒN cần verify với sim booted + app pin thật: attach Frida unpin đầu-cuối (host này có
    frida 17.3.2 nhưng chưa sim nào booted). UI nút "cài hàng loạt" trên màn Sims (mới có backend
    + agent tool).
  - **Giới hạn kỹ thuật (ghi rõ):** iOS Simulator chỉ chạy **bản build simulator**. IPA App Store
    (FB/TikTok…) là ARM device + FairPlay → **không chạy được trên simulator** (Apple chặn), nên
    không thể "cài TikTok IPA lên sim". Unpin thì app-agnostic cho app chạy được trên sim. Muốn test
    app App Store thật cần **thiết bị thật** (ngoài phạm vi SimFleet).
- [ ] **P5 polish:** dock chat riêng cho Workbench (CÒN).
- Tests: 11/11 pass (mitm HTTP/HTTPS, service capture/repeater/intruder, ws parser x3, ws e2e,
  install batch x2).
