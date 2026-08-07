## Context

JAgentDesk giữ parity với snapshot tham chiếu cục bộ tại `scratchpad/reference`. Kiến trúc hiện
tại được khảo sát từ snapshot đó:

- **Transport:** một protocol WebSocket logic tại path `/ws`, hai transport vật lý:
  - _Direct_: client dial `ws(s)://host:port/ws` (`packages/protocol/src/daemon-endpoints.ts:169`,
    default listen `127.0.0.1:6768`).
  - _Legacy relay_: snapshot có transport outbound tới dịch vụ trung gian, chỉ chuyển byte đã mã hoá
    E2EE (`packages/server/src/server/relay-transport.ts:109`). Luồng này không tồn tại trong sản phẩm.
- **Handshake ứng dụng:** client gửi `hello {clientId, clientType, protocolVersion, ...}`;
  server kiểm tra `protocolVersion === WS_PROTOCOL_VERSION`, tạo/khôi phục session theo
  `clientId`, trả một `status` chứa `server_info` (`websocket-server.ts:1401-1529`).
- **Auth hiện tại (3 cơ chế rời):** (a) daemon password bearer bcrypt qua header
  `Authorization: Bearer` và subprotocol `jagentdesk.bearer.<token>` (`packages/server/src/server/auth.ts`);
  (b) daemon E2EE keypair Curve25519 box **chỉ dùng cho relay** (`daemon-keypair.ts`,
  `packages/relay/src/crypto.ts:117-156`); (c) pairing offer chuyển public key của daemon tới
  client qua QR/URL `#offer=` (`packages/protocol/src/connection-offer.ts:9-19`,
  `packages/server/src/server/pairing-offer.ts`). **Chưa có định danh per-device hay chứng
  chỉ client được ký.**
- **Lưu trữ:** JSON file-based dưới `$JAGENTDESK_HOME` (`~/.jagentdesk`), Zod-validated, atomic
  temp+rename, không migration framework (`scratchpad/reference/docs/data-model.md:33-39`).
- **Push:** daemon POST thẳng `https://exp.host/--/api/v2/push/send` (Expo), token store
  `push-tokens.json` (`packages/server/src/server/push/push-service.ts:25`,
  `token-store.ts`). Không đi qua relay, nhưng phụ thuộc Expo cloud + EAS projectId.
- **UI:** một codebase Expo/React-Native-Web (`packages/app`) chạy cả mobile lẫn desktop
  (Electron host bản web export — `packages/desktop/src/main.ts:797` load renderer nội bộ).

## Goals / Non-Goals

**Goals:**

- Port **đầy đủ** bề mặt tính năng JAgentDesk (agents đa provider, workspaces/worktree, terminals,
  git/forge, diff/file view, composer/permissions, voice, schedules/heartbeats/loops, chat,
  browser automation, command center, settings, i18n, CLI).
- Thay relay bằng **tsnet** giữ nguyên hợp đồng `attachSocket(ws, ExternalSocketMetadata)`
  ở phía WS server, và giữ nguyên mô hình `hello`/`server_info`.
- Thêm **pairing + ký kết nối** ở tầng ứng dụng để chống node tailnet tuỳ ý.
  - App mobile mở đầu bằng **màn nhập pairing offer**; chỉ sau khi offer hợp lệ được lưu mới
    mở màn đăng nhập Tailscale (login tương tác hoặc auth key), rồi mới yêu cầu mã sáu số.
- Push miễn phí, riêng tư (content-light, chi tiết qua Tailscale).

**Non-Goals:**

- **Sửa file trong app** (in-app file editing) — bỏ hoàn toàn; chỉ xem file/diff.
- Tự host APNs/FCM ở phase 1 (chỉ dùng Expo broker).
- Không port relay server, hosted web app, Hub, hạ tầng website phát hành hoặc auto-update tập trung.
- Đổi mô hình protocol, mô hình lưu trữ, hay bộ token thiết kế — giữ parity với snapshot tham chiếu.

## Decisions

### D1 — Transport tsnet thay relay, giữ nguyên seam `attachSocket`

Điểm thay: seam transport outbound trong snapshot (`relay-transport.ts:109`) được thay bằng một
**tsnet listener**. Mô hình đảo chiều: thay vì "daemon
dial relay, relay fan-in client", daemon **serve `/ws` trực tiếp trên tailnet**, client dial
thẳng địa chỉ tailnet của daemon. Hợp đồng bắt buộc giữ: với mỗi client được accept, gọi
`attachSocket(ws, ExternalSocketMetadata)` (`bootstrap.ts:1568-1583`,
  `websocket-server.ts:900-909`). Runtime relay legacy,
và WS server **không cần đổi**. Phía client, seam song song là `isRelayClientWebSocketUrl` +
`buildRelayWebSocketUrl` + `createRelayE2eeTransportFactory`
(`packages/client/src/daemon-client-relay-e2ee-transport.ts:18`,
`daemon-endpoints.ts:176,243`) → thay bằng đường dial tailnet trực tiếp.

Lớp E2EE-box của relay **bị bỏ**:
WireGuard của Tailscale đã cung cấp mã hoá + định danh node. `daemon-keypair.ts` được **tái
dụng** cho mục đích mới (ký kết nối ở D2), không còn cho E2EE-box.

### D2 — Pairing + ký kết nối (chống node tailnet tuỳ ý)

Ở trên Tailscale (đã có mã hoá + định danh node), thêm một lớp uỷ quyền ứng dụng:

- **Định danh thiết bị:** mỗi client (desktop/mobile) sinh một keypair thiết bị; public key
  đăng ký vào daemon khi pair (mở rộng `push-tokens.json`/thêm `paired-devices.json`).
- **Pairing offer:** tái dụng `ConnectionOffer` (`connection-offer.ts`) nhưng bỏ trường relay,
  thêm địa chỉ tailnet của daemon + daemon public key. Offer chuyển qua QR/URL `#offer=` như
  JAgentDesk (`pairing-offer.ts:14-68`).
- **Ký mỗi kết nối:** thay `hello` phẳng bằng `hello` có chữ ký: client ký một challenge
  (nonce do daemon phát) bằng private key thiết bị; daemon xác thực với public key đã pair
  trước khi nâng cấp session. Thiết bị chưa pair bị từ chối (đóng với mã lỗi rõ ràng), song
  song với cách relay E2EE từ chối key lạ (`encrypted-channel.ts:503-531`).
- **Thu hồi:** gỡ public key khỏi danh sách đã pair ⇒ kết nối sau bị từ chối.
- **Một phiên pairing đang hoạt động:** daemon chỉ giữ một request chờ xác thực và một mã sáu số
  cho mỗi lần pairing. Socket retry của cùng device key dùng lại request/mã đó; device khác bị
  từ chối cho tới khi request kết thúc, bị huỷ hoặc hết hạn.

Đây là thay đổi ảnh hưởng bảo mật + protocol ⇒ cần ADR riêng (`transport-tailscale`,
`pairing-and-signing`, `security`).

### D3 — Offer trước, Tailscale login sau, mã sáu số ở cuối

Cây route mobile hiện tại: cold start vào `/` (`packages/app/src/app/index.tsx:19`) →
`/pair-start` nếu chưa có host hoặc offer. Người dùng phải nhận offer từ desktop bằng QR,
deep-link hoặc paste link trước; `pair-verify` lưu offer rồi mới điều hướng tới
`/tailscale-login` nếu node chưa connected. Sau khi login xong, app quay lại `pair-verify`,
thực hiện signed challenge và chỉ hoàn tất enrollment khi người dùng nhập đúng mã sáu số.
`Continue with Local` là nhánh explicit độc lập. Desktop khởi động ở Tailscale mặc định
nhưng vẫn cho chọn Local.

### D4 — Bỏ editor, file panel chỉ-đọc

Không port `packages/app/src/file-pane/editor/`. `diff-and-files` giữ diff viewer
(`git-diff-pane.tsx`), file explorer (`file-explorer-pane.tsx`), preview pane
(`file-pane/pane.tsx`) ở chế độ đọc, image lightbox. Mọi RPC ghi file (`fs.file.write.request`
— `messages.ts:2247`) **không** được đưa vào bề mặt client; giữ đọc/subscribe
(`fs.file.subscribe/unsubscribe`).

### D5 — Push content-light qua Expo, chi tiết qua Tailscale

Giữ nguyên đường Expo của JAgentDesk (`push-service.ts`, `use-push-token-registration.ts`) nhưng:
payload chỉ chứa loại sự kiện + id mờ (không code/prompt/nội dung file); khi user chạm, app
fetch chi tiết **qua Tailscale**. Attention policy giữ nguyên
(`agent-attention-policy.ts:42-79`: client present+focused ⇒ nén; `error` không push-eligible;
ngưỡng present 180s). JAgentDesk ship EAS build riêng để có projectId hợp lệ. Phase-2 (tuỳ
chọn, cần ADR): gửi thẳng APNs `.p8` + FCM để bỏ hop Expo.

### D6 — Đổi tên/nhãn & HOME

`$JAGENTDESK_HOME` (default `~/.jagentdesk`); scheme desktop `jagentdesk://`; giữ nguyên layout
thư mục theo entity (`docs/data-model.md`). ID mờ giữ tiền
tố tương đương (`prj_`, `wks_`, `srv_`, `agent uuid`) — quyết định giữ nguyên để giảm rủi ro.

### D7 — Giữ nguyên mô hình protocol & envelope

Không thiết kế lại protocol. Giữ `WSInboundMessageSchema`/`WSOutboundMessageSchema`, wrap
`session`, correlation `requestId`, `rpc_error`, binary frame terminal (opcode 0x01–0x04) và
file-transfer (256 KiB chunk). Chỉ mở rộng `hello` cho chữ ký (D2) và bỏ nhánh relay/e2ee.

## Risks / Trade-offs

- **tsnet trên mobile:** tsnet là thư viện Go nhúng cho daemon. Client mobile join tailnet qua
  app Tailscale/OS integration, không nhúng tsnet vào Expo. Rủi ro: trải nghiệm login Tailscale
  trong app mobile phụ thuộc khả năng của nền tảng (đã có POC ở `scratchpad-tsnet-poc`). Cần
  xác thực đường login tương tác vs auth key trên iOS/Android.
- **Bỏ E2EE-box:** chấp nhận tin cậy WireGuard làm lớp mã hoá; hợp lý vì Tailscale là biên tin
  cậy. Ký kết nối (D2) bù lại phần uỷ quyền ứng dụng mà node-trong-tailnet không có.
- **Phụ thuộc Expo cloud cho push iOS:** không tránh được nếu muốn thông báo khi app bị kill
  (iOS bắt buộc APNs). Giảm thiểu bằng payload content-light. Sàn chi phí $99/năm Apple.
- **Khối lượng port lớn:** toàn bộ bề mặt JAgentDesk. Rủi ro sót tính năng ⇒ dùng `PARITY` matrix
  đối chiếu từng vùng với `file:line` JAgentDesk trong pha review.
- **Đổi tên HOME/scheme:** rủi ro tham chiếu chết ⇒ grep toàn bộ khi triển khai.
