# Burp Workbench — UI reference (Burp Suite Community Edition parity)

Tài liệu này mô tả **UI của Burp Suite Community Edition** để dựng lại 1:1 trong JAgentDesk.
Nguồn: tài liệu chính thức PortSwigger (`portswigger.net/burp/documentation`) + quan sát bản CE.
Đây là **mô tả Burp**, không phải quyết định sản phẩm — muốn khác Burp thì ghi rõ lý do ở
`docs/plans/active/burp-workbench.md`.

Tên feature trong app: **Workbench** (rail/route `security` / `workbench`). Không dùng chữ
"Burp" trong chuỗi UI hoặc route (thương hiệu của PortSwigger); chỉ tham chiếu trong tài liệu.

## 0. Khung tổng thể (main window)

Burp CE là 1 cửa sổ với **hàng tab ngang trên cùng** (top-level tools), mỗi tab là 1 công cụ:

```
Dashboard | Target | Proxy | Intruder | Repeater | Sequencer | Decoder | Comparer | Logger | Extensions | Learn | Settings
```

- Mỗi tool lại có **sub-tab** riêng (vd Proxy → Intercept / HTTP history / WebSockets history / Proxy settings).
- Message editor (request/response) xuất hiện lặp lại ở nhiều tool: 2 panel cạnh nhau
  (request trái, response phải) hoặc trên/dưới, mỗi panel có sub-tab **Pretty | Raw | Hex**
  (response thêm **Render**) và nút **Inspector** ở mép phải.
- Bảng dữ liệu (HTTP history, site map) có thể **sort theo cột**, **filter bar** ở trên,
  và **context menu chuột phải** với "Send to Repeater / Intruder / Decoder / Comparer /
  Sequencer", "Add to scope", "Copy URL", "Show response in browser"…
- Phối màu Burp: nền xám sáng, accent **cam Burp `#ff6633`** (nút chính, highlight), chữ
  đen trên nền trắng cho bảng; header tab active gạch chân cam.

## 1. Dashboard
- Panel **Tasks** (CE: chủ yếu "Live passive crawl from Proxy"), panel **Event log**
  (INFO/DEBUG/ERROR + thời gian), panel **Issue activity** (CE hạn chế scanner nên thường trống).
- Layout 2×2 các panel, mỗi panel có thanh tiêu đề + filter nhỏ.

## 2. Target
### 2.1 Site map (sub-tab)
- **Trái**: cây URL phân cấp theo host → path. Method hiện cạnh node (GET/POST…). Chữ **đen =
  đã request**, **xám = suy luận/chưa request**. Chấm tròn màu = mức severity issue.
- **Phải trên**: bảng contents, cột: **Host · Method · URL · Params · Status · Length ·
  MIME type · Title · Comment** (Params/Status… có thể trống). Sort được.
- **Phải dưới**: message editor request/response cho item đang chọn + Inspector.
- **Issues pane** (dưới cùng khi có): tab **Advisory | Request | Response**.
- Context menu: Add to scope, Spider/crawl (CE giới hạn), Send to Repeater/Intruder…, Compare
  site maps, Expand/collapse branch, Delete host.

### 2.2 Scope (sub-tab)
- 2 bảng: **Include in scope** và **Exclude from scope**. Mỗi dòng: Enabled(checkbox) ·
  Protocol · Host/IP range · Port · File. Nút **Add / Edit / Remove / Paste URL**.
- Toggle **"Use advanced scope control"** đổi sang nhập bằng regex.
- Checkbox **"And URL Is in target scope"** ở filter của history.

### 2.3 Issue definitions — danh sách mô tả loại lỗi (đọc-only, CE có sẵn).

## 3. Proxy
### 3.1 Intercept (sub-tab)
- Thanh nút: **Forward** · **Drop** · **Intercept is on/off** (toggle) · **Open Browser** ·
  **Action** (menu = context menu của message editor).
- Vùng dưới: message editor 1 message đang bị giữ (Pretty/Raw/Hex + Inspector). Sửa được rồi Forward.

### 3.2 HTTP history (sub-tab)
- **Filter bar** trên cùng (bấm mở popover): filter theo request type, MIME, status code,
  search term, show only in-scope, hide CSS/image/binary…
- Bảng, cột (mặc định): **# · Host · Method · URL · Params · Edited · Status code · Length ·
  MIME type · Extension · Title · Comment · TLS · IP · Cookies · Time · Listener port**.
  Dòng được tô màu theo highlight người dùng đặt (đỏ/cam/vàng/lục/lam/tím/…).
- Dưới bảng: message editor request/response của dòng đang chọn.

### 3.3 WebSockets history (sub-tab)
- Bảng, cột: **# · URL · Direction (→ client/→ server) · Edited · Length · Comment · Time**.
- Dưới: viewer 1 message WS (Pretty/Raw/Hex).

### 3.4 Proxy settings — Proxy listeners (interface:port, mặc định `127.0.0.1:8080`),
request/response interception rules, response modification, match & replace, TLS
(CA certificate: **Import / export CA certificate**), WebSocket interception.

## 4. Intruder (CE = bản demo, bị bóp tốc độ + giới hạn thời gian)
Sub-tab: **Positions | Payloads | Resource pool | Settings**.
- **Positions**: chọn **Attack type** (Sniper / Battering ram / Pitchfork / Cluster bomb);
  vùng request có các dấu **`§ … §`** đánh dấu vị trí chèn; nút **Add § / Clear § / Auto § /
  Refresh**. Nút **Start attack** (góc phải trên).
- **Payloads**: **Payload set** (chọn set # + type), **Payload settings** (Simple list, Runtime
  file, Numbers, Dates, Brute forcer, Username generator…), **Payload processing** (add rule),
  **Payload encoding**.
- **Resource pool**: chọn/ tạo pool (max concurrent requests, delay).
- **Settings**: request headers, grep-match, grep-extract, redirections.
- **Attack window** (mở riêng): bảng kết quả cột **Request # · Payload · Status · Error ·
  Timeout · Length · Comment**, dưới là request/response của dòng chọn; cột grep tuỳ chọn.

## 5. Repeater
- **Hàng tab request** (mỗi request 1 tab, đổi tên/nhóm được) + nút **+**.
- Nút **Send** (to, cam) + **Cancel**; mũi tên **< >** đi lại lịch sử gửi của tab; ô **Target**
  (host:port + HTTPS toggle) góc phải.
- 2 panel: **Request** (trái) / **Response** (phải), mỗi cái Pretty/Raw/Hex (response thêm
  Render), có Inspector. Ô **notes** cho tab. Hiện **thời gian phản hồi + độ dài** ở đáy response.

## 6. Sequencer
- **Live capture**: chọn 1 request có token → chọn **token location** (cookie/form field/custom
  regex) → **Start live capture**; hiện số token đã thu + **Pause/Stop**, nút **Analyze now**.
- **Manual load**: dán danh sách token.
- **Analysis options**: token handling, character/bit level.
- **Kết quả**: **Summary** (overall entropy, reliability), **Character-level analysis**,
  **Bit-level analysis**, biểu đồ.

## 7. Decoder
- 1 vùng nhập trên; mỗi phép biến đổi tạo **panel mới xếp dọc** bên dưới.
- Mỗi panel có: toggle **Text / Hex**, dropdown **Decode as** (URL / HTML / Base64 / ASCII hex /
  Hex / Octal / Binary / Gzip), **Encode as** (cùng danh sách), **Hash** (MD5/SHA-1/SHA-256/…),
  nút **Smart decode**.

## 8. Comparer
- Bảng danh sách item (2+), cột **# · Length · Data**. Nút **Paste / Load / Remove / Clear**.
- 2 nút so sánh: **Words** / **Bytes**. Mở cửa sổ so sánh 2 cột cạnh nhau, tô màu
  modified/deleted/added, toggle **Sync views** + **Text/Hex**.

## 9. Logger — bảng mọi request Burp gửi qua mọi tool; cột tương tự HTTP history + cột **Tool**.
Có filter bar, export.

## 10. Message editor & Inspector (dùng chung)
- Sub-tab **Pretty | Raw | Hex** (+ **Render** cho response). Thanh search trong editor.
- **Inspector** (panel phải, thu gọn được): các section **Request attributes** (method, path,
  HTTP version), **Query parameters**, **Body parameters**, **Request cookies**, **Request
  headers**, **Response headers**… — mỗi mục sửa key/value trực tiếp, số đếm ở tiêu đề section.

## 11. Điểm khác biệt CE ↔ Pro (giữ đúng CE)
- **Không** có active Scanner tự động, không Burp Collaborator client đầy đủ, không lưu project
  (CE chỉ temporary project), Intruder **bị bóp tốc độ + giới hạn thời gian**, không extension
  API dạng BApp store trả phí, không DOM Invader/Organizer đầy đủ.
- Feature JAgentDesk sẽ **giữ giới hạn tương đương CE** ở Intruder (để đúng "Community
  Edition") — quyết định này ghi ở plan.
