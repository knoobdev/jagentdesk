# JAgentDesk

JAgentDesk là ứng dụng self-hosted để theo dõi và điều khiển coding agent chạy trên máy của
bạn. Daemon chạy cục bộ, còn desktop và mobile kết nối trực tiếp qua Tailscale. Mỗi thiết bị
mobile phải hoàn tất pairing ở tầng ứng dụng và nhập mã xác minh 6 số trước khi được cấp quyền.

Dự án này được fork từ [Paseo](https://github.com/getpaseo/paseo), sau đó được rebrand và phát
triển riêng cho các ranh giới của JAgentDesk:

- Không có editor trong app; app chỉ xem file, diff và điều khiển agent.
- Tailscale là transport từ xa duy nhất; không có relay server của JAgentDesk.
- Có application-level pairing bằng offer link/QR và mã xác minh 6 số.
- Có luồng orchestration Supervisor → Lead → Peer và entry point `/orc`.

## Thành phần

- `packages/server` — daemon, vòng đời agent, WebSocket API và Tailscale bridge.
- `packages/app` — client Expo cho iOS, Android và web.
- `packages/desktop` — app Electron cho macOS, Windows và Linux.
- `packages/client` và `packages/protocol` — client dùng chung và contract giao thức.
- `packages/cli` — CLI điều khiển daemon.

## Cài đặt và chạy nhanh

Yêu cầu Node.js `22.20.0` và npm. Repo có thể dùng mise để cài đúng toolchain trong
`.tool-versions`; Android local build cần thêm Android SDK, còn iOS local build cần Xcode.

```bash
git clone https://github.com/knoobdev/jagentdesk.git
cd jagentdesk
npm install
```

Chạy daemon, mobile/web và desktop ở các terminal riêng:

```bash
npm run dev:server
npm run dev:app
npm run dev:desktop
```

Daemon dev lắng nghe tại `127.0.0.1:6768`. Xem thêm [docs/development.md](docs/development.md),
[docs/android.md](docs/android.md) và [docs/mobile-testing.md](docs/mobile-testing.md).

## Sử dụng desktop và mobile

### 1. Đăng nhập Tailscale

1. Mở JAgentDesk Desktop và vào phần host/overview.
2. Trong **Tailscale connection**, chọn **Sign in with Tailscale** và hoàn tất đăng nhập trong
   cửa sổ trình duyệt.
3. Chờ trạng thái host chuyển sang **Online**. Mobile cũng phải đăng nhập vào cùng tailnet.

Nếu không muốn dùng trình duyệt trong lúc test, Tailscale auth key có thể được nhập ở màn hình
đăng nhập của mobile. Không commit auth key vào repo hoặc đưa auth key vào issue/log.

### 2. Pair mobile với desktop

1. Trên desktop mở **Pair a device**.
2. Dùng **Copy** để copy nguyên pairing offer link, hoặc quét QR.
3. Trên mobile mở luồng pair, dán offer link vào ô pairing link rồi kết nối.
4. Khi desktop nhận được tín hiệu offer từ mobile, card **Device connection request** mới xuất
   hiện cùng mã xác minh và countdown.
5. Xác nhận đúng thiết bị trên desktop, nhập mã 6 số vào mobile và chờ trạng thái **Device
   connected successfully**.

Pairing offer link không phải là quyền truy cập hoàn chỉnh. Thiết bị vẫn cần tailnet access,
identity key và mã xác minh do desktop hiển thị.

### 3. Mở project và agent

Sau khi pairing, chọn **Add a project** hoặc **Import session** trên mobile. Trên desktop, chọn
project/workspace rồi mở agent tương ứng. Provider CLI (Claude Code, Codex, Copilot, OpenCode,
Pi...) vẫn dùng credential của chính provider trên máy chạy daemon; JAgentDesk không thu thập
credential đó.

## Cài mobile không ký bằng Sideloadly

### Android

Tải file APK từ GitHub Release `v1.0.0` hoặc release tương ứng. Bật cho phép cài ứng dụng từ
nguồn này trong Android Settings, mở APK và cài đặt. File `.aab` dành cho Play Store/EAS không
phải file cài trực tiếp; hãy dùng artifact `.apk`.

### iPhone/iPad

GitHub Actions tạo IPA cho device bằng profile EAS `production-ipa`; artifact có tên dạng
`JAgentDesk-v1.0.0-ios.ipa`. Đây là IPA device, không phải app Simulator. Để sideload trên thiết
bị thật, Sideloadly sẽ ký lại IPA bằng Apple ID/certificate của người cài:

1. Cài [Sideloadly](https://sideloadly.io/) trên macOS hoặc Windows.
2. Kết nối iPhone bằng USB, mở khóa và bấm **Trust** nếu iOS hỏi.
3. Mở Sideloadly, chọn thiết bị, kéo file IPA vào vùng IPA và nhập Apple ID.
4. Bấm **Start**, hoàn tất xác thực Apple ID nếu được yêu cầu.
5. Trên iPhone vào **Settings → General → VPN & Device Management**, tin cậy developer
   profile rồi mở JAgentDesk.

IPA phải được build cho device. Có thể build thủ công từ thư mục `packages/app` bằng
`eas build --platform ios --profile production-ipa`; profile `production-simulator` chỉ dùng cho
iOS Simulator. Apple ID miễn phí có thể có thời hạn ký ngắn; khi app hết hạn, sideload lại IPA.

## Build và release bằng GitHub Actions

Workflow `.github/workflows/release.yml` chạy khi push tag semver dạng `v*.*.*`. Tag đầu tiên của
repo này là `v1.0.0` và phải khớp version `1.0.0` trong các package.

- Desktop build theo matrix macOS, Windows và Linux, sau đó upload installer vào GitHub Release.
- Mobile Android được prebuild và compile trực tiếp trên runner, sau đó upload APK cài thử.
- Mobile iOS dùng EAS profile `production-ipa`, chờ build device hoàn tất, tải `.ipa` đã ký và
  upload vào GitHub Release.

GitHub Actions tự có `GITHUB_TOKEN`, nhưng job IPA cần secret `EXPO_TOKEN` và Apple signing
credentials đã được cấu hình trong EAS project. Tạo secret tại repository Settings → Secrets and
variables → Actions → New repository secret với tên `EXPO_TOKEN`. APK Android của workflow là bản
cài thử, không phải artifact đã ký để phát hành Play Store.

Tạo release đầu tiên:

```bash
git tag v1.0.0
git push origin main --tags
```

Chạy kiểm tra/build tương ứng ở local:

```bash
npm run typecheck
npm run lint
npm run build:desktop -- --publish never
cd packages/app
npx eas build --platform android --profile production-apk
```

## License

JAgentDesk được phát hành theo AGPL-3.0-or-later.

Cảm ơn Paseo và các contributor của Paseo vì nền tảng ban đầu đã giúp JAgentDesk bắt đầu nhanh
hơn.
