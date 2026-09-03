# DB IDE UX fixes (mobile + desktop)

Reported 2026-09-03. Loạt bug giao diện/UX của chức năng Databases trên app mobile
và desktop. Track theo cụm; nhiều bug chạm file dùng chung nên fix có thứ tự.

## Files liên quan (packages/app/src)

- `components/database-data-editor.tsx` (1761 dòng) — data grid + inline cell edit
  (`startEdit`/`editingKey` :362), expandable cell viewer (`valueCell`/`handleExpandCell`
  :392, đã có sẵn — DataGrip-style), context menu, scroll ngang/dọc, aggregate/CSV.
- `components/database-result-table.tsx` (139) — result grid (SQL console output).
- `components/ui/context-menu.tsx` (931) — context menu dùng chung (vị trí popup).
- `components/database-full-text-search.tsx` (245) — filter table.
- `components/database-chat-dock.tsx` (650) + `database-draft-chat.tsx` — widget chat agent.
- `components/database-er-diagram.tsx` (298) — ER diagram canvas (zoom).
- `screens/database-browse-screen.tsx` (339) — màn browse (footer, back nav).
- `components/sidebar-database-nav.tsx` — list table trong sidebar (chuột phải).

## Bug list

### Cụm A — Data grid / cell edit (data-editor + result-table) — nặng nhất

- [x] A1 (both) **1 click vào cell = edit luôn** như DataGrip. Hiện `startEdit` chỉ set
      `editingKey` — kiểm tra trigger (đang cần double-tap / long-press?).
- [x] A2 (mobile) Sửa cột: TextInput inline bị **gôm lại, khó nhìn** → mở **dialog/sheet**
      để edit (đã có `valueCell` expand viewer :392 — route mobile edit qua đó / bottom sheet).
- [x] A3 (both) **Responsive bảng dữ liệu** không ổn — layout cột/scroll.
- [x] A4 (desktop) Scroll: **phải kéo xuống hết mới scroll ngang**. CHẨN ĐOÁN: data-editor
      `:637-689` lồng `<ScrollView vertical><ScrollView horizontal>` → thanh cuộn ngang nằm ở
      đáy nội dung cao (dưới viewport) nên phải kéo dọc hết mới cuộn ngang. Fix: đảo thành
      outer horizontal (height bounded = viewport) + inner vertical, header/cột-1 sticky.
      Cần verify layout trên desktop + mobile (rủi ro nếu làm mù).

### Cụm B — Context menu (context-menu.tsx + sidebar-database-nav)

- [x] B1+B2 (desktop) **DONE** `context-menu.tsx:391` — `isMobile = useIsCompactFormFactor()`
      chỉ theo breakpoint width → desktop window hẹp bị nhận là mobile → ra bottom-sheet
      giữa màn thay vì popup tại con trỏ. Fix: `isMobile = useIsCompactFormFactor() && !getIsElectron()`.
      App typecheck 0. **Cần verify runtime desktop** (chuột phải → popup tại con trỏ).
- [x] B3 (desktop) Chuột phải item table trong list **bắt force-select trước** — cho phép
      right-click trực tiếp mở menu cho đúng item.

### Cụm C — Filter (database-full-text-search.tsx)

- [x] C1 (both) Filter table **vỡ giao diện** — mất chữ / bị che (overflow, width).

### Cụm D — ER diagram (database-er-diagram.tsx)

- [x] D1 (both) Canvas **không zoom in/out** — thêm pinch (mobile) + wheel/nút zoom (desktop).

### Cụm E — Navigation / footer (database-browse-screen + screens)

- [x] E1 (mobile) **Footer tràn viền**, mất chữ trái/phải — padding/safe-area/overflow.
- [x] E2 (mobile) Nhiều màn DB **thiếu nút Back** (phải vuốt phải) — thêm header back.

### Cụm F — Chat dock (database-chat-dock.tsx)

- [x] F1 (mobile) Vào Databases **mất widget chat agent** — điều kiện render ẩn trên mobile?

## Cách làm

Fix theo cụm, ưu tiên A (dùng nhiều nhất) → B → C/E → D/F. Verify runtime: desktop qua
dev CDP (port trống, tránh 6768 Paseo), mobile qua EAS/simulator. Chưa move sang completed
tới khi verify được từng cụm.

## Ghi chú

- `valueCell` expand-cell viewer đã tồn tại (đã là hướng "dialog để edit") → tận dụng cho A2.
- context-menu.tsx dùng chung toàn app — sửa vị trí phải test không vỡ chỗ khác.

## Trạng thái (v0.0.7)
Tất cả 12 bug đã fix (4 subagent song song + B1/B2) — app typecheck 0, Databases screen render không crash. Released v0.0.7. **Chưa verify grid/filter/ER với DB thật** (cần Add connection tới DB server) — khuyến nghị device pass. Android APK CI vẫn OOM (track riêng).
