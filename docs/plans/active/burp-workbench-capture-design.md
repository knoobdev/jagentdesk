# Workbench — bắt traffic & TLS inspection trên SimFleet

Ngữ cảnh: đây là **workbench kiểm thử bảo mật ứng dụng** cho các iOS **Simulator chạy trên
chính máy host của người dùng** (feature SimFleet). Mọi thao tác dưới đây tác động lên
simulator do người dùng sở hữu/điều khiển — dùng để kiểm thử app được phép, giống cặp Burp +
objection/Frida trong pentest hợp lệ.

## 1. Sự thật kỹ thuật về iOS Simulator

- Simulator **dùng chung network stack của máy Mac** (không phải thiết bị thật). Không có
  cấu hình Wi-Fi proxy per-device như iPhone thật.
- Cài CA của proxy vào simulator: `xcrun simctl keychain <udid> add-root-cert <ca.pem>`
  (Xcode 12.5+). Sau đó app trong sim tin CA đó cho TLS mặc định.
- App của sim là **tiến trình macOS** dưới CoreSimulator → Frida bản host attach được theo
  PID/tên tiến trình (không cần `-U`/USB như device thật). Script gỡ pinning hook ObjC/BoringSSL
  chạy được vì framework có mặt trong sim.

## 2. Vấn đề "phân biệt đang capture sim nào"

Vì mọi sim chia sẻ network của Mac, không thể tách theo IP. Cách giải quyết (chọn A cho MVP):

- **A. Per-app forced proxy qua Frida (chọn).** Với mỗi phiên capture, chọn **sim (udid) + app
  (bundle id)**. Inject Frida vào tiến trình app đó: (1) ép mọi kết nối đi qua
  `127.0.0.1:<listenerPort>` riêng của phiên, (2) tắt SSL pinning. Vì mỗi phiên có **listener
  port riêng**, traffic tự gắn đúng `sessionId → udid → bundleId`. Đây cũng là cách
  objection/frida-gadget làm.
- **B. PID→UDID attribution (bổ sung).** Với transparent/system proxy, khi 1 socket local kết
  nối vào proxy, tra PID của socket (qua `lsof -nP -i` hoặc proc API), map PID → simulator qua
  đường dẫn tiến trình CoreSimulator (chứa udid) để gắn nhãn. Dùng khi không inject được Frida.
- **C. System proxy toàn máy (fallback).** Set proxy hệ thống của Mac; bắt được tất cả nhưng
  không phân biệt sim → chỉ dùng khi người dùng bật rõ ràng.

## 3. Luồng một phiên capture (MVP = phương án A)

1. Người dùng chọn **Start capture** trên màn Workbench → chọn sim (list từ SimFleet) + app.
2. Daemon mở **listener proxy** cổng động, sinh/cache **CA của workbench**, cài CA vào sim
   (`simctl keychain add-root-cert`) nếu chưa có.
3. Daemon spawn/attach **Frida** vào app: nạp script (a) unpinning, (b) ép proxy về listener.
4. Traffic app → listener → upstream; mỗi request/response ghi vào **capture store** kèm
   `sessionId, udid, bundleId, timestamp_ms`.
5. UI HTTP history nhận stream realtime; người dùng Send to Repeater/Intruder/Decoder…
6. **Stop capture** gỡ Frida, dừng listener; tuỳ chọn gỡ CA.

## 4. Frida scripts — chiến lược tích hợp codeshare (quyết định)

Yêu cầu người dùng: tổng hợp script từ `codeshare.frida.re/browse` để tự gỡ SSL pinning.

**Không** bundle mù hàng loạt script bên thứ ba (license không rõ, chất lượng/độ an toàn không
kiểm soát, dễ hỏng theo phiên bản). Thay vào đó:

1. **Bộ script tuyển chọn, được kiểm thử, đóng gói kèm app**: các script unpinning cộng đồng
   phổ biến & được bảo trì (objection iOS pinning bypass, "multiple unpinning" tổng hợp
   SecTrust/BoringSSL/NSURLSession/AFNetworking/TrustKit…). Ghi rõ nguồn + license mỗi file.
2. **Loader theo yêu cầu từ codeshare**: người dùng nhập **slug** (vd `<author>/<project>`);
   daemon tải script đó từ codeshare API, hiện nội dung để **duyệt trước khi chạy**, cache
   local. Không tự chạy script tải về khi chưa duyệt.
3. **Registry** trong app: bảng script (tên, nguồn, phiên bản, đã bật/tắt, "auto-run khi
   capture"). Chọn nhiều script áp cho 1 phiên.
4. **"Auto unpin" mặc định**: khi bật, phiên capture tự nạp bộ tuyển chọn ở (1) — người dùng
   tắt được.

License/an toàn: mỗi script kèm header nguồn+license; loader chỉ tải qua API chính thức của
codeshare; nội dung hiện cho người dùng duyệt.

## 5. Điều khiển từ agent chat (MCP tools)

Nhóm tool trên MCP server `jagentdesk` (đặt tên `wb_*` hoặc `proxy_*`), agent gọi được:
- `wb_capture_start({udid, bundleId, autoUnpin})` / `wb_capture_stop({sessionId})`
- `wb_sessions_list()` — các phiên đang chạy + đang gắn sim nào.
- `wb_history_query({sessionId?, host?, method?, status?, contains?, limit})`
- `wb_request_get({id})` / `wb_repeater_send({id|raw, target})`
- `wb_intruder_run({...})` (giữ giới hạn CE) / `wb_decoder({data, op})`
- `wb_frida_scripts_list()` / `wb_frida_script_load({slug})` / `wb_frida_apply({sessionId, scriptIds})`
- Agent tự biết sim đang capture nhờ `sessionId → udid` trong session store.

## 6. Quản lý capture (UI)
Màn **Captures**: danh sách phiên (sim + app + trạng thái + #requests + thời lượng), nút
Start/Stop, chọn script Frida, export (HAR/JSON), xoá. Mỗi phiên mở ra chính là nguồn dữ liệu
cho các tab Proxy/Target/Repeater… (giống "project" tạm của Burp CE).

## 7. Phụ thuộc kỹ thuật cần thêm (daemon-side)
- Thư viện proxy MITM cho Node (tự dựng trên `http`/`https`/`net` + `tls` sinh cert theo SNI,
  hoặc dựa lib có sẵn — quyết định ở plan sau khi rà `packages/server/package.json`).
- `frida` (node binding) hoặc gọi CLI `frida`/`frida-ps` nếu đã có trên host; kiểm tra sẵn có.
- `xcrun simctl` (đã dùng bởi SimFleet).
- Sinh CA/cert: `node-forge` hoặc `selfsigned`.
Mọi phụ thuộc phải kiểm tra trùng với native-module packaging (xem memory
`electron-builder-native-modules-empty`).
